import { describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { gateAppFiles, runAgentHook, writeWorkspaceFiles } from './helpers'

// Cursor's contract differs from Claude Code's: the verdict goes to stdout as a
// followup_message and the exit code stays 0; the gate itself is the shared one.

const hook = resolve(import.meta.dir, '../templates/agent/targets/cursor/hooks/gate-on-stop.ts')

function followUp(stdout: string): string | undefined {
  return stdout.trim() === '' ? undefined : (JSON.parse(stdout) as { followup_message?: string }).followup_message
}

const runHook = (setup: (dir: string) => void | Promise<void>, input: Record<string, unknown>) =>
  runAgentHook(hook, input, setup)

describe('cursor stop hook', () => {
  test('gates only a completed turn', async () => {
    const result = await runHook((dir) => writeFileSync(join(dir, 'lib.ts'), 'export const a = 1\n'), { status: 'aborted' })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  test('hands a failing gate back as a followup_message and exits 0', async () => {
    const result = await runHook(async (dir) => {
      Bun.spawnSync(['git', 'init', '-q'], { cwd: dir })
      await writeWorkspaceFiles(dir, gateAppFiles({ codegen: 'true', typecheck: 'false', test: 'true' }))
    }, { status: 'completed', loop_count: 0 })

    expect(result.exitCode).toBe(0)
    const message = followUp(result.stdout)
    expect(message).toContain('guren gate: typecheck failed (`bun run typecheck` exited 1)')
    expect(message).toContain('Fix these, then run `bunx guren gate`')
  })

  test('stays silent when the gate passes', async () => {
    const result = await runHook(async (dir) => {
      Bun.spawnSync(['git', 'init', '-q'], { cwd: dir })
      await writeWorkspaceFiles(dir, gateAppFiles({ codegen: 'true', typecheck: 'true', test: 'true' }))
    }, { status: 'completed', loop_count: 0 })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })
})
