import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { cp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { assertWorkspaceBuilt, captureWarnings, createTempWorkspace, linkWorkspacePackage, OXLINT_BIN, type TempWorkspace } from './helpers'
import { addLint, LINT_SCRIPTS, oxlintRange } from '../src/add-lint'
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
