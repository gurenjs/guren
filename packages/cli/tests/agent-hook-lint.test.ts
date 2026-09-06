import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { linkOxlint, runAgentHook } from './helpers'

// The oxlint half of the edit hook (see runAgentHook for how it is driven). The
// edited files sit outside the watched paths, so `guren check` never runs here;
// it is covered by its own tests.

const hook = resolve(import.meta.dir, '../templates/agent/targets/claude/hooks/check-after-edit.ts')
// A built-in rule keeps the test independent of which plugin the app configures.
const CONFIG = JSON.stringify({ rules: { 'no-debugger': 'warn' } })

function runHook(
  app: (dir: string) => void,
  editedFile: string,
  options: { installed?: boolean } = {},
): Promise<{ exitCode: number; stderr: string }> {
  return runAgentHook(hook, { tool_input: { file_path: editedFile } }, async (dir) => {
    if (options.installed !== false) await linkOxlint(dir)
    app(dir)
  })
}

const FLAGGED_FILE = 'debugger\nexport const a = 1\n'

describe('check-after-edit hook: oxlint', () => {
  test('reports findings on the edited file, warnings included, and exits 2', async () => {
    const result = await runHook((dir) => {
      writeFileSync(join(dir, '.oxlintrc.json'), CONFIG)
      writeFileSync(join(dir, 'lib.ts'), FLAGGED_FILE)
    }, 'lib.ts')

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('oxlint found 1 issue(s)')
    expect(result.stderr).toContain('lib.ts:1:1:')
    expect(result.stderr).toContain('eslint(no-debugger)')
  })

  test('stays quiet without an .oxlintrc.json, and on a clean file', async () => {
    expect((await runHook((dir) => writeFileSync(join(dir, 'lib.ts'), FLAGGED_FILE), 'lib.ts')).exitCode).toBe(0)
    const clean = await runHook((dir) => {
      writeFileSync(join(dir, '.oxlintrc.json'), CONFIG)
      writeFileSync(join(dir, 'lib.ts'), 'export const a = 1\n')
    }, 'lib.ts')
    expect(clean.exitCode).toBe(0)
  })

  test('a config that fails to load is reported, not read as clean', async () => {
    const result = await runHook((dir) => {
      writeFileSync(join(dir, '.oxlintrc.json'), JSON.stringify({ jsPlugins: ['./missing-plugin.js'] }))
      writeFileSync(join(dir, 'lib.ts'), FLAGGED_FILE)
    }, 'lib.ts')

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('without linting lib.ts')
  })

  test('a file the config ignores is not a failure', async () => {
    const result = await runHook((dir) => {
      writeFileSync(join(dir, '.oxlintrc.json'), JSON.stringify({ ignorePatterns: ['gen/**'], rules: { 'no-debugger': 'warn' } }))
      mkdirSync(join(dir, 'gen'))
      writeFileSync(join(dir, 'gen', 'x.ts'), FLAGGED_FILE)
    }, 'gen/x.ts')
    expect(result.exitCode).toBe(0)
  })

  test('a config without an installed oxlint asks for bun install', async () => {
    const result = await runHook((dir) => {
      writeFileSync(join(dir, '.oxlintrc.json'), CONFIG)
      writeFileSync(join(dir, 'lib.ts'), FLAGGED_FILE)
    }, 'lib.ts', { installed: false })

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('run `bun install`')
  })

  test('skips generated and non-source paths', async () => {
    const result = await runHook((dir) => {
      writeFileSync(join(dir, '.oxlintrc.json'), CONFIG)
      mkdirSync(join(dir, '.guren'))
      writeFileSync(join(dir, '.guren', 'routes.gen.ts'), FLAGGED_FILE)
    }, '.guren/routes.gen.ts')
    expect(result.exitCode).toBe(0)
  })
})
