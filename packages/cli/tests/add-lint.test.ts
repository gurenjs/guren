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

  // RFC 0027 §7: the shipped config scopes the rule to application code by glob.
  it('reports a raw env read in application code and nowhere else', async () => {
    await linkWorkspacePackage('cli', workspace.dir)
    await addLint()
    const inScope = ['app/Services/Mailer.ts', 'config/mail.ts', 'routes/web.ts', 'src/app.ts', 'modules/billing/index.ts']
    const outOfScope = ['bin/serve.ts', 'drizzle.config.ts']
    for (const path of [...inScope, ...outOfScope]) {
      await mkdir(dirname(resolve(path)), { recursive: true })
      await writeFile(path, 'export const url = process.env.SMTP_HOST\n')
    }

    const { output } = lintApp(workspace.dir)

    const reported = [...output.matchAll(/^(.+?):\d+:\d+: .*no-unvalidated-env-read/gmu)].map((match) => match[1]).sort()
    expect(reported).toEqual([...inScope].sort())
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
      if (!source.includes('process.env.')) continue
      const template = toPosixRelative(scaffoldRoot, file)
      // The app path: without the blueprint directory and a `definition/` form segment.
      const target = template.split('/').slice(1).filter((segment, index) => index > 0 || segment !== 'definition').join('/')
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
