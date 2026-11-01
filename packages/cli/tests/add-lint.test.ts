import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { assertWorkspaceBuilt, captureWarnings, createTempWorkspace, linkWorkspacePackage, OXLINT_BIN, type TempWorkspace } from './helpers'
import { addLint, LINT_SCRIPTS, oxlintRange } from '../src/add-lint'
import { collectFiles, IMPORTABLE_EXTENSIONS, NON_SOURCE_DIR_NAMES, toPosixRelative } from '../src/discovery'
import { runBlueprint } from '../src/blueprints'

const repoRoot = resolve(import.meta.dir, '../../..')
assertWorkspaceBuilt([join(repoRoot, 'packages/cli/dist/oxlint/index.js')])

const MANIFEST = {
  name: 'app',
  scripts: { typecheck: 'tsc --noEmit' },
  devDependencies: { typescript: '^5.4.0' },
}

async function readManifest(): Promise<{ scripts: Record<string, string>; devDependencies: Record<string, string> }> {
  return JSON.parse(await readFile('package.json', 'utf8'))
}

describe('guren add lint', () => {
  let workspace: TempWorkspace

  beforeEach(async () => {
    workspace = await createTempWorkspace('guren-add-lint-')
    await writeFile('package.json', `${JSON.stringify(MANIFEST, null, 2)}\n`)
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  it('writes the config, the lint scripts, and the oxlint dev dependency', async () => {
    const created = await runBlueprint('lint')

    expect(created).toContain(resolve('.oxlintrc.json'))
    expect(created).toContain(resolve('package.json'))
    expect(await readFile('.oxlintrc.json', 'utf8')).toContain('"jsPlugins": ["@guren/cli/oxlint"]')
    const manifest = await readManifest()
    expect(manifest.scripts).toEqual({ typecheck: 'tsc --noEmit', ...LINT_SCRIPTS })
    expect(manifest.devDependencies).toEqual({ typescript: '^5.4.0', oxlint: oxlintRange() })
    expect(await readFile('package.json', 'utf8')).toEndWith('}\n')
  })

  it('keeps a lint script and an oxlint range the app already has', async () => {
    await writeFile('package.json', JSON.stringify({ ...MANIFEST, scripts: { lint: 'eslint .' }, devDependencies: { oxlint: '1.0.0' } }))

    const { result: created, warnings } = await captureWarnings(() => runBlueprint('lint'))

    const manifest = await readManifest()
    expect(manifest.scripts).toEqual({ lint: 'eslint .', 'lint:fix': LINT_SCRIPTS['lint:fix'] })
    expect(manifest.devDependencies).toEqual({ oxlint: '1.0.0' })
    expect(created).toContain(resolve('package.json'))
    // A range the plugin was not tested against is kept, but said so.
    expect(warnings.join('\n')).toContain('oxlint 1.0.0')
  })

  it('refuses to overwrite an existing config without --force', async () => {
    await writeFile('.oxlintrc.json', '{}\n')

    await expect(runBlueprint('lint')).rejects.toThrow('already exists')
    expect(await readManifest()).toEqual(MANIFEST)

    await runBlueprint('lint', { force: true })
    expect(await readFile('.oxlintrc.json', 'utf8')).toContain('@guren/cli/oxlint')
  })

  it('leaves nothing behind when package.json is missing or malformed', async () => {
    await rm('package.json')
    await expect(runBlueprint('lint')).rejects.toThrow('ENOENT')
    expect(existsSync('.oxlintrc.json')).toBe(false)

    await writeFile('package.json', '{ not json')
    await expect(runBlueprint('lint')).rejects.toThrow()
    expect(existsSync('.oxlintrc.json')).toBe(false)
  })

  it('installs the oxlint this repo lints with: the peer range admits the root pin', async () => {
    const root = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as { devDependencies: Record<string, string> }
    expect(oxlintRange()).toStartWith('~')
    expect(Bun.semver.satisfies(root.devDependencies.oxlint!, oxlintRange())).toBe(true)
  })

  function lintApp(appDir: string): { output: string; exitCode: number } {
    const result = Bun.spawnSync([OXLINT_BIN, '--format', 'unix'], { cwd: appDir, stdout: 'pipe', stderr: 'pipe' })
    expect(result.stderr.toString()).toBe('')
    return { output: result.stdout.toString(), exitCode: result.exitCode }
  }

  // RFC 0027 §7 for env reads; the Guren UI tokens for raw colors. The shipped config scopes each by glob.
  it.each([
    {
      rule: 'no-unvalidated-env-read',
      source: 'export const url = process.env.SMTP_HOST\n',
      inScope: ['app/Services/Mailer.ts', 'config/mail.ts', 'routes/web.ts', 'src/app.ts', 'modules/billing/index.ts'],
      outOfScope: ['bin/serve.ts', 'drizzle.config.ts'],
    },
    {
      rule: 'no-raw-color',
      source: "export const tone = 'bg-red-500'\n",
      inScope: ['resources/js/pages/Home.tsx', 'resources/js/components/Badge.tsx'],
      outOfScope: ['app/Mail/WelcomeMail.tsx', 'src/app.ts'],
    },
  ])('reports $rule in its scope and nowhere else', async ({ rule, source, inScope, outOfScope }) => {
    await linkWorkspacePackage('cli', workspace.dir)
    await mkdir('resources/css', { recursive: true })
    await writeFile('resources/css/guren.css', ':root {}\n')
    await addLint()
    for (const path of [...inScope, ...outOfScope]) {
      await mkdir(dirname(resolve(path)), { recursive: true })
      await writeFile(path, source)
    }

    const { output } = lintApp(workspace.dir)

    const reported = [...output.matchAll(new RegExp(`^(.+?):\\d+:\\d+: .*${rule}`, 'gmu'))].map((match) => match[1]).sort()
    expect(reported).toEqual([...inScope].sort())
  })

  // An app older than guren.css would start red on every page, with nothing to switch to.
  it('leaves no-raw-color out of the config of an app with no Guren UI tokens', async () => {
    await mkdir('resources/js', { recursive: true })

    await addLint()

    const config = await readFile('.oxlintrc.json', 'utf8')
    expect(config).not.toContain('guren/no-raw-color')
    expect(config).toContain('"guren/no-unvalidated-env-read": "error"')
  })

  // Every provider form still ships for apps with no config/env.ts, and each reads
  // process.env on purpose; `add lint` in such an app must not start red.
  it('lints every scaffold template that reads process.env with no errors', async () => {
    await linkWorkspacePackage('cli', workspace.dir)
    await addLint()
    const scaffoldRoot = join(repoRoot, 'packages/cli/templates/scaffold')
    const written = new Map<string, string>()
    for (const file of await collectFiles(scaffoldRoot, IMPORTABLE_EXTENSIONS, NON_SOURCE_DIR_NAMES)) {
      const source = await readFile(file, 'utf8')
      if (!/process\.env[.[]/u.test(source)) continue
      const template = toPosixRelative(scaffoldRoot, file)
      // The app path starts at the first scoped root, past `<blueprint>/` and any form or variant directory.
      const segments = template.split('/')
      const root = segments.findIndex((segment) => ['app', 'config', 'routes', 'src', 'modules'].includes(segment))
      if (root === -1) continue
      const target = segments.slice(root).join('/')
      expect(written.get(target)).toBeUndefined()
      written.set(target, template)
      await mkdir(dirname(resolve(target)), { recursive: true })
      await writeFile(target, source)
    }
    expect(written.size).toBeGreaterThan(0)

    const { output } = lintApp(workspace.dir)

    expect(output).not.toContain('no-unvalidated-env-read')
    expect(output).not.toContain('[Error/')
  })

  // Through the real binary, against the built dist: a fresh app must have no
  // error-level finding, or the first `bun run lint` a user sees is red. The
  // templates ship the config; `add lint` is what an older app runs to get it.
  it.each(['default', 'api-only'])('lints the %s starter template with no errors', async (template) => {
    const appDir = join(workspace.dir, template)
    await cp(join(repoRoot, 'packages', 'create-app', 'templates', template), appDir, { recursive: true })
    await linkWorkspacePackage('cli', appDir)
    await rm(join(appDir, '.oxlintrc.json'))
    await addLint({ cwd: appDir })

    const result = Bun.spawnSync([OXLINT_BIN, '--format', 'unix'], { cwd: appDir, stdout: 'pipe', stderr: 'pipe' })
    const output = result.stdout.toString()

    expect(result.stderr.toString()).toBe('')
    expect(output).not.toContain('[Error/')
    expect(output).not.toContain('node_modules/')
    expect(result.exitCode).toBe(0)
  })
})
