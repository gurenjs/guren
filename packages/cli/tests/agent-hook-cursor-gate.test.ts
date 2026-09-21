import { describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { gateAppFiles, initGitRepo, runAgentHook, writeWorkspaceFiles } from './helpers'
import { HTTP_STEP, writePlanVerifyApp } from './plan-fixture'

// Cursor's contract differs from Claude Code's: the verdict goes to stdout as a
// followup_message and the exit code stays 0; the gate itself is the shared one.

const template = resolve(import.meta.dir, '../templates/agent/targets/cursor/hooks/gate-on-stop.ts')

const runHook = (input: Record<string, unknown>, setup: (dir: string) => void | Promise<void>) =>
  runAgentHook(template, '.cursor/hooks/gate-on-stop.ts', input, setup)

const failingApp = async (dir: string) => {
  initGitRepo(dir)
  await writeWorkspaceFiles(dir, gateAppFiles({ codegen: 'true', typecheck: 'false', test: 'true' }))
}

describe('cursor stop hook', () => {
  test('gates only a completed turn', async () => {
    const result = await runHook({ status: 'aborted' }, (dir) => writeFileSync(join(dir, 'lib.ts'), 'export const a = 1\n'))

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  test('stops following up once its per-conversation bound is reached', async () => {
    const result = await runHook({ status: 'completed', loop_count: 3 }, failingApp)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })

  test('hands a failing gate back as a followup_message and exits 0', async () => {
    const result = await runHook({ status: 'completed', loop_count: 0 }, failingApp)

    expect(result.exitCode).toBe(0)
    const { followup_message } = JSON.parse(result.stdout) as { followup_message?: string }
    expect(followup_message).toContain('guren gate: typecheck failed (`bun run typecheck` exited 1)')
    expect(followup_message).toContain('Run `bunx guren gate`')
  })

  test('hands an incomplete plan step back as a followup_message', async () => {
    const result = await runHook({ status: 'completed', loop_count: 0 }, async (dir) => {
      await writePlanVerifyApp(dir, { plan: 'comments.plan.json', step: HTTP_STEP, startedAt: 't', continuations: 0 })
      initGitRepo(dir)
      Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'add', '-A'], { cwd: dir })
      Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init'], { cwd: dir })
    })

    expect(result.exitCode).toBe(0)
    const { followup_message } = JSON.parse(result.stdout) as { followup_message?: string }
    expect(followup_message).toContain(`plan:verify on stop (comments.plan.json, ${HTTP_STEP}): the step is incomplete, so this turn is not done (continuation 1 of 3).`)
  })

  test('stays silent when the gate passes', async () => {
    const result = await runHook({ status: 'completed' }, async (dir) => {
      initGitRepo(dir)
      await writeWorkspaceFiles(dir, gateAppFiles({ codegen: 'true', typecheck: 'true', test: 'true' }))
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('')
  })
})
