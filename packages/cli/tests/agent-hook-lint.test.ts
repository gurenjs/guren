import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// The shipped hook, run the way Claude Code runs it: `bun <hook>` with the tool
// input on stdin, from the app root. The app has no @guren/cli here, so only the
// oxlint half is exercised; `guren check` is covered by its own tests.

const repoRoot = resolve(import.meta.dir, '../../..')
const hook = join(repoRoot, 'packages/cli/templates/agent/targets/claude/hooks/check-after-edit.ts')
// A built-in rule keeps the test independent of which plugin the app configures.
const CONFIG = JSON.stringify({ rules: { 'no-debugger': 'warn' } })

function runHook(app: (dir: string) => void, editedFile: string): { exitCode: number; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'guren-hook-lint-'))
  try {
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    symlinkSync(join(repoRoot, 'node_modules', 'oxlint'), join(dir, 'node_modules', 'oxlint'), 'dir')
    app(dir)
    const result = Bun.spawnSync([process.execPath, hook], {
      cwd: dir,
      stdin: Buffer.from(JSON.stringify({ tool_input: { file_path: join(dir, editedFile) } })),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return { exitCode: result.exitCode, stderr: result.stderr.toString() }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const FLAGGED_FILE = 'debugger\nexport const a = 1\n'

describe('check-after-edit hook: oxlint', () => {
  test('reports findings on the edited file, warnings included, and exits 2', () => {
    const result = runHook((dir) => {
      writeFileSync(join(dir, '.oxlintrc.json'), CONFIG)
      writeFileSync(join(dir, 'lib.ts'), FLAGGED_FILE)
    }, 'lib.ts')

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('oxlint found 1 issue(s)')
    expect(result.stderr).toContain('lib.ts:1:1:')
    expect(result.stderr).toContain('eslint(no-debugger)')
  })

  test('stays quiet without an .oxlintrc.json, and on a clean file', () => {
    expect(runHook((dir) => writeFileSync(join(dir, 'lib.ts'), FLAGGED_FILE), 'lib.ts').exitCode).toBe(0)
    expect(
      runHook((dir) => {
        writeFileSync(join(dir, '.oxlintrc.json'), CONFIG)
        writeFileSync(join(dir, 'lib.ts'), 'export const a = 1\n')
      }, 'lib.ts').exitCode,
    ).toBe(0)
  })

  test('a config that fails to load is reported, not read as clean', () => {
    const result = runHook((dir) => {
      writeFileSync(join(dir, '.oxlintrc.json'), JSON.stringify({ jsPlugins: ['./missing-plugin.js'] }))
      writeFileSync(join(dir, 'lib.ts'), FLAGGED_FILE)
    }, 'lib.ts')

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('without linting lib.ts')
  })

  test('skips generated and non-source paths', () => {
    expect(
      runHook((dir) => {
        writeFileSync(join(dir, '.oxlintrc.json'), CONFIG)
        mkdirSync(join(dir, '.guren'))
        writeFileSync(join(dir, '.guren', 'routes.gen.ts'), FLAGGED_FILE)
              }, '.guren/routes.gen.ts').exitCode,
    ).toBe(0)
  })
})
