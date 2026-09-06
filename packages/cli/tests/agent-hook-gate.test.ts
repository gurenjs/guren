import { describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { gateAppFiles, initGitRepo, runAgentHook, writeWorkspaceFiles } from './helpers'

// The real gate runs against the temp app (see runAgentHook); its stage rules
// are covered by gate.test.ts. `true`/`false` stand in for the subprocess stages.

const template = resolve(import.meta.dir, '../templates/agent/core/hooks/gate-on-stop.ts')
const codexConfig = resolve(import.meta.dir, '../templates/agent/targets/codex/hooks.json')

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

  test("the shipped Codex command finds the app's .codex/ upward from a subdirectory", async () => {
    const command = (JSON.parse(readFileSync(codexConfig, 'utf8')) as { hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> } })
      .hooks.Stop[0]!.hooks[0]!.command
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
})
