import { describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { gateAppFiles, runClaudeHook, writeWorkspaceFiles } from './helpers'

// The real gate runs against the temp app (see runClaudeHook); its stage rules
// are covered by gate.test.ts. `true`/`false` stand in for the subprocess stages.

const hook = resolve(import.meta.dir, '../templates/agent/targets/claude/hooks/gate-on-stop.ts')

function git(dir: string, ...args: string[]): void {
  const result = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`)
}

const runHook = (setup: (dir: string) => void | Promise<void>, input: Record<string, unknown> = {}) =>
  runClaudeHook(hook, input, setup)

describe('gate-on-stop hook', () => {
  test('lets a stop through once a Stop hook has already blocked it', async () => {
    const result = await runHook((dir) => writeFileSync(join(dir, 'lib.ts'), 'export const a = 1\n'), { stop_hook_active: true })

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
  })

  test('does not gate a clean working tree', async () => {
    const result = await runHook((dir) => {
      git(dir, 'init', '-q')
      writeFileSync(join(dir, 'lib.ts'), 'export const a = 1\n')
      git(dir, 'add', '-A')
      git(dir, 'commit', '-q', '-m', 'init')
    })

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
  })

  test('blocks a stop with uncommitted changes when a stage fails, naming the stage', async () => {
    const result = await runHook(async (dir) => {
      git(dir, 'init', '-q')
      await writeWorkspaceFiles(dir, gateAppFiles({ codegen: 'true', typecheck: 'false', test: 'true' }))
    })

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('guren gate: typecheck failed (`bun run typecheck` exited 1)')
    expect(result.stderr).not.toContain('guren gate: check failed')
    expect(result.stderr).toContain('Run `bunx guren gate`')
  })

  test('lets a stop through when the gate passes on uncommitted changes', async () => {
    const result = await runHook(async (dir) => {
      git(dir, 'init', '-q')
      await writeWorkspaceFiles(dir, gateAppFiles({ codegen: 'true', typecheck: 'true', test: 'true' }))
    })

    expect(result.stderr).toBe('')
    expect(result.exitCode).toBe(0)
  })

  test('outside a git repository the gate runs (the tree cannot be judged clean)', async () => {
    const result = await runHook((dir) => writeFileSync(join(dir, 'lib.ts'), 'export const a = 1\n'))

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('guren gate: check failed')
  })
})
