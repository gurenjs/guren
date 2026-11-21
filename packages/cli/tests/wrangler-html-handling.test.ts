import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTempWorkspace, type TempWorkspace } from './helpers'
import { getDoctorRuleEvaluations } from '../src/doctor'
import { upgradeCanary } from '../src/upgrade'
import { planHtmlHandling } from '../src/wrangler-html-handling'

const COMMENTED = `{
  // The worker's name on the account.
  "name": "legacy",
  "main": ".cloudflare/worker.js",
  "define": { "import.meta.url": "\\"file:///worker.js\\"" },
  "assets": {
    "directory": ".cloudflare/assets", // staged by the build
    "binding": "ASSETS"
  },
  /* D1 */
  "d1_databases": [{ "binding": "DB", "database_id": "0000" }],
}
`

function patchedOf(text: string): string {
  const plan = planHtmlHandling(text)
  if (plan.kind !== 'missing' || plan.patched === undefined) throw new Error(`no patch: ${JSON.stringify(plan)}`)
  return plan.patched
}

describe('planHtmlHandling', () => {
  it('adds the key after the last property and keeps comments and formatting', () => {
    expect(patchedOf(COMMENTED)).toBe(
      COMMENTED.replace('    "binding": "ASSETS"\n', '    "binding": "ASSETS",\n    "html_handling": "none"\n'),
    )
  })

  it('reuses a trailing comma and starts after a comment that closes the object', () => {
    const text = '{\n\t"assets": {\n\t\t"directory": "./.cloudflare/assets/", // staged\n\t},\n}\n'
    expect(patchedOf(text)).toBe(text.replace('// staged\n', '// staged\n\t\t"html_handling": "none"\n'))
  })

  it('patches a one-line object in place', () => {
    expect(patchedOf('{ "assets": { "directory": ".cloudflare/assets" } }')).toBe(
      '{ "assets": { "directory": ".cloudflare/assets", "html_handling": "none" } }',
    )
  })

  it('reads the assets of the root object, not a nested key of that name', () => {
    const root = '"assets": { "directory": ".cloudflare/assets" }'
    const text = `{\n  "env": { "staging": { "assets": { "directory": "staging" } } },\n  ${root}\n}\n`
    expect(patchedOf(text)).toBe(text.replace(root, '"assets": { "directory": ".cloudflare/assets", "html_handling": "none" }'))
  })

  it('leaves a config that names a value, whichever it is', () => {
    expect(planHtmlHandling('{ "assets": { "html_handling": "none" } }')).toEqual({ kind: 'set', environments: [] })
    expect(planHtmlHandling('{ "assets": { "html_handling": "auto-trailing-slash" } }')).toEqual({
      kind: 'other',
      value: '"auto-trailing-slash"',
      environments: [],
    })
  })

  it('offers no patch for assets the build does not stage', () => {
    expect(planHtmlHandling('{ "assets": { "directory": "./dist" } }')).toEqual({ kind: 'missing', staged: false, environments: [] })
    expect(planHtmlHandling('{ "assets": { /* set after building */ } }')).toEqual({ kind: 'missing', staged: false, environments: [] })
  })

  it('names each environment whose own assets lack the key', () => {
    const text = `{
      "assets": { "directory": ".cloudflare/assets", "html_handling": "none" },
      "env": {
        "staging": { "assets": { "directory": ".cloudflare/assets" } },
        "production": { "assets": { "directory": ".cloudflare/assets", "html_handling": "none" } },
        "preview": { "vars": {} }
      }
    }`
    expect(planHtmlHandling(text)).toEqual({ kind: 'set', environments: ['staging'] })
  })

  it('has nothing to add to a config that serves no assets', () => {
    expect(planHtmlHandling('{ "name": "api" }')).toEqual({ kind: 'no-assets', environments: [] })
  })

  it('reports a file that is not JSON with comments', () => {
    expect(planHtmlHandling('{ "assets": { ').kind).toBe('unreadable')
    expect(planHtmlHandling('[]')).toEqual({ kind: 'unreadable', reason: 'its root is not an object' })
  })

  it('reports a block comment that never closes, which Wrangler rejects', () => {
    expect(planHtmlHandling('{ "assets": { "directory": ".cloudflare/assets", "html_handling": "none" } } /*')).toEqual({
      kind: 'unreadable',
      reason: 'a block comment is never closed',
    })
  })
})

describe('the cloudflare-html-handling doctor rule', () => {
  let workspace: TempWorkspace
  const configPath = (): string => join(workspace.dir, 'wrangler.jsonc')
  const htmlHandlingCheck = async () =>
    (await getDoctorRuleEvaluations({ cwd: workspace.dir })).evaluations.find((evaluation) => evaluation.check.key === 'cloudflare-html-handling')!

  beforeEach(async () => {
    workspace = await createTempWorkspace('wrangler-html-handling-')
    await writeFile(join(workspace.dir, 'package.json'), JSON.stringify({ name: 'workers-test' }), 'utf8')
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  it('passes an app with no wrangler.jsonc', async () => {
    const { check, autofix } = await htmlHandlingCheck()
    expect(check.status).toBe('pass')
    expect(autofix).toBeNull()
  })

  it('names what another value leads to, and offers no autofix', async () => {
    await writeFile(configPath(), '{ "assets": { "directory": "a", "html_handling": "auto-trailing-slash" } }', 'utf8')
    const { check, autofix } = await htmlHandlingCheck()
    expect(check.status).toBe('warn')
    expect(check.message).toContain('"html_handling": "auto-trailing-slash"')
    expect(check.message).toContain('extensionless path')
    expect(autofix).toBeNull()
  })

  it('reports a config it cannot read instead of failing the run', async () => {
    await mkdir(configPath())
    const { check, autofix } = await htmlHandlingCheck()
    expect(check.status).toBe('warn')
    expect(check.message).toContain('could not be read')
    expect(autofix).toBeNull()
  })

  it('passes an app that deploys through cloudflare.config.ts, whatever wrangler.jsonc holds', async () => {
    await writeFile(configPath(), COMMENTED, 'utf8')
    await writeFile(join(workspace.dir, 'cloudflare.config.ts'), 'export default {}\n', 'utf8')
    expect((await htmlHandlingCheck()).check.status).toBe('warn')

    await writeFile(join(workspace.dir, 'package.json'), JSON.stringify({ name: 'workers-test', devDependencies: { cf: '^1.0.0' } }), 'utf8')
    const { check, autofix } = await htmlHandlingCheck()
    expect(check.status).toBe('pass')
    expect(check.message).toContain('cloudflare.config.ts')
    expect(autofix).toBeNull()
  })

  it('leaves assets the build does not stage to the author', async () => {
    await writeFile(configPath(), '{ "assets": { "directory": "./dist" } }', 'utf8')
    const { check, autofix } = await htmlHandlingCheck()
    expect(check.status).toBe('warn')
    expect(check.message).toContain('.cloudflare/assets')
    expect(autofix).toBeNull()
  })

  it('warns on an environment whose assets replace a root that sets the key', async () => {
    await writeFile(
      configPath(),
      '{ "assets": { "directory": ".cloudflare/assets", "html_handling": "none" }, "env": { "staging": { "assets": { "directory": ".cloudflare/assets" } } } }',
      'utf8',
    )
    const { check, autofix } = await htmlHandlingCheck()
    expect(check.status).toBe('warn')
    expect(check.message).toContain('env.staging')
    expect(autofix).toBeNull()
  })

  it('is applied by guren upgrade, and previewed under --dry-run', async () => {
    await writeFile(configPath(), COMMENTED, 'utf8')
    expect((await htmlHandlingCheck()).check.canAutofix).toBe(true)

    const preview = await upgradeCanary({ cwd: workspace.dir, tag: 'canary', dryRun: true })
    expect(preview.autofixes.find((autofix) => autofix.key === 'cloudflare-html-handling')?.applied).toBe(false)
    expect(await readFile(configPath(), 'utf8')).toBe(COMMENTED)

    const result = await upgradeCanary({ cwd: workspace.dir, tag: 'canary' })
    expect(result.autofixes.find((autofix) => autofix.key === 'cloudflare-html-handling')?.applied).toBe(true)
    expect(await readFile(configPath(), 'utf8')).toBe(patchedOf(COMMENTED))
    expect((await htmlHandlingCheck()).check.status).toBe('pass')
  })
})
