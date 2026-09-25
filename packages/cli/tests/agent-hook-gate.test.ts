import { describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { PLAN_STATE_VERSION, type PlanState } from '../src/plan/state'
import { gateAppFiles, initGitRepo, runAgentHook, shippedHookCommand, writeWorkspaceFiles } from './helpers'
import { HTTP_STEP, writePlanVerifyApp } from './plan-fixture'

// The real gate runs against the temp app (see runAgentHook); its stage rules
// are covered by gate.test.ts. `true`/`false` stand in for the subprocess stages.

const template = resolve(import.meta.dir, '../templates/agent/core/hooks/gate-on-stop.ts')

const ACTIVE = { stop_hook_active: false }

function git(dir: string, ...args: string[]): void {
  const result = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`)
}

const failingApp = (dir: string) => writeWorkspaceFiles(dir, gateAppFiles({ codegen: 'true', typecheck: 'false', test: 'true' }))

describe('gate-on-stop hook (Claude Code / Codex contract)', () => {
  test('lets a stop through once a Stop hook has already blocked it', async () => {
    const result = await runAgentHook(template, '.claude/hooks/gate-on-stop.ts', { stop_hook_active: true }, failingApp)

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
  })

  test('leaves the turn to a host that does not speak this contract (Cursor loading .claude/settings.json)', async () => {
    const result = await runAgentHook(template, '.claude/hooks/gate-on-stop.ts', { status: 'completed', cursor_version: '2.4.0' }, failingApp)

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
  })

  test('does not gate a clean working tree', async () => {
    const result = await runAgentHook(template, '.claude/hooks/gate-on-stop.ts', ACTIVE, (dir) => {
      git(dir, 'init', '-q')
      writeFileSync(join(dir, 'lib.ts'), 'export const a = 1\n')
      git(dir, 'add', '-A')
      git(dir, 'commit', '-q', '-m', 'init')
    })

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
  })

  test('blocks a stop with uncommitted changes when a stage fails, naming the stage', async () => {
    const result = await runAgentHook(template, '.claude/hooks/gate-on-stop.ts', ACTIVE, async (dir) => {
      initGitRepo(dir)
      await failingApp(dir)
    })

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('guren gate: typecheck failed (`bun run typecheck` exited 1)')
    expect(result.stderr).not.toContain('guren gate: check failed')
    expect(result.stderr).toContain('Run `bunx guren gate`')
  })

  test('lets a stop through when the gate passes on uncommitted changes', async () => {
    const result = await runAgentHook(template, '.claude/hooks/gate-on-stop.ts', ACTIVE, async (dir) => {
      initGitRepo(dir)
      await writeWorkspaceFiles(dir, gateAppFiles({ codegen: 'true', typecheck: 'true', test: 'true' }))
    })

    expect(result.stderr).toBe('')
    expect(result.exitCode).toBe(0)
  })

  test('outside a git repository the gate runs (the tree cannot be judged clean)', async () => {
    const result = await runAgentHook(template, '.claude/hooks/gate-on-stop.ts', ACTIVE, (dir) => writeFileSync(join(dir, 'lib.ts'), 'export const a = 1\n'))

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('guren gate: check failed')
  })

  test('gates the app it is installed in, not the cwd (Codex runs hooks in the session cwd)', async () => {
    const result = await runAgentHook(
      template,
      '.codex/hooks/gate-on-stop.ts',
      ACTIVE,
      async (dir) => {
        initGitRepo(dir)
        await failingApp(dir)
      },
      { subdir: 'routes' },
    )

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('guren gate: typecheck failed')
  })

  test('verifies the plan step plan:next marked, blocks while it is incomplete, and counts the continuation', async () => {
    let state: PlanState | undefined
    const result = await runAgentHook(
      template,
      '.claude/hooks/gate-on-stop.ts',
      ACTIVE,
      async (dir) => {
        // Committed, so the gate has nothing to run and the plan step is what the stop is judged on.
        await writePlanVerifyApp(dir, { plan: 'comments.plan.json', step: HTTP_STEP, startedAt: 't', continuations: 0 })
        git(dir, 'init', '-q')
        git(dir, 'add', '-A')
        git(dir, 'commit', '-q', '-m', 'init')
      },
      { after: async (dir) => { state = JSON.parse(await readFile(join(dir, '.guren/plans/comments.state.json'), 'utf8')) as PlanState } },
    )

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain(`plan:verify on stop (comments.plan.json, ${HTTP_STEP}): the step is incomplete, so this turn is not done (continuation 1 of 3).`)
    expect(result.stderr).toContain('  not at its completion state: action.comments.destroy: planned')
    expect(result.stderr).not.toContain('guren gate:')
    expect(state!.stateVersion).toBe(PLAN_STATE_VERSION)
    expect(state!.active).toMatchObject({ step: HTTP_STEP, continuations: 1 })
    expect(state!.steps[HTTP_STEP]).toMatchObject({ outcome: 'incomplete' })
  })

  test('gives the marked step up after its continuations, letting the stop through with the reason', async () => {
    const result = await runAgentHook(template, '.claude/hooks/gate-on-stop.ts', { stop_hook_active: true }, async (dir) => {
      await writePlanVerifyApp(dir, { plan: 'comments.plan.json', step: HTTP_STEP, startedAt: 't', continuations: 3 })
    })

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain(`plan:verify on stop (comments.plan.json, ${HTTP_STEP}): giving up, 3 continuations on this step.`)
    expect(result.stderr).toContain('The step is recorded as stalled.')
  })

  test("the shipped Codex command finds the app's .codex/ upward from a subdirectory", async () => {
    const command = await shippedHookCommand('targets/codex/hooks.json', 'Stop')
    const result = await runAgentHook(
      template,
      '.codex/hooks/gate-on-stop.ts',
      ACTIVE,
      async (dir) => {
        initGitRepo(dir)
        await failingApp(dir)
      },
      { subdir: 'app/Http', argv: ['sh', '-c', command] },
    )

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('guren gate: typecheck failed')
  })

  test('the shipped Claude Code command gates the app from a subdirectory the agent cd-ed into', async () => {
    const command = await shippedHookCommand('targets/claude/settings.json', 'Stop')
    const result = await runAgentHook(
      template,
      '.claude/hooks/gate-on-stop.ts',
      ACTIVE,
      async (dir) => {
        initGitRepo(dir)
        await failingApp(dir)
      },
      { subdir: 'app/Http', argv: ['bash', '-c', command], env: (dir) => ({ CLAUDE_PROJECT_DIR: dir }) },
    )

    expect(result.stderr).not.toContain('Module not found')
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('guren gate: typecheck failed')
  })

  // CLAUDE_PROJECT_DIR stays at the session's start after Claude enters a worktree,
  // so the project's copy runs while the input cwd names the worktree.
  test('gates the worktree the session cwd is in, not the project the script was run from', async () => {
    const result = await runAgentHook(
      template,
      '.claude/hooks/gate-on-stop.ts',
      ACTIVE,
      async (dir) => {
        await writeFile(join(dir, '.gitignore'), '.claude/worktrees/\nnode_modules/\n')
        git(dir, 'init', '-q')
        git(dir, 'add', '-A')
        git(dir, 'commit', '-q', '-m', 'init')
        const worktree = join(dir, '.claude/worktrees/x')
        await mkdir(join(worktree, '.claude/hooks'), { recursive: true })
        await writeFile(join(worktree, '.claude/hooks/gate-on-stop.ts'), await readFile(template, 'utf8'))
        initGitRepo(worktree)
        await failingApp(worktree)
        await mkdir(join(worktree, 'app'), { recursive: true })
      },
      { subdir: '.claude/worktrees/x/app' },
    )

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('guren gate: typecheck failed')
  })
})
