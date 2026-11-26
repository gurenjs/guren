#!/usr/bin/env bun
/**
 * Stop hook (Claude Code and Codex share this contract): when the agent ends a
 * turn with uncommitted changes in this app, run `guren gate` (the CI stages:
 * codegen, typecheck, lint, check, audit, test) and block the stop with the
 * findings (exit 2, stderr), so the fix happens in this turn rather than in CI.
 * Then, while `guren plan:next` has marked a plan step, verify it and block until it
 * is verified or the hook gives up (RFC 0030 §7), which it says on stderr.
 */
import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

interface HookInput {
  /** Sent by every host speaking this contract; `true` once a Stop hook already blocked this stop. */
  stop_hook_active?: boolean
  /** The session's cwd, which follows the agent's `cd` and a worktree it entered. */
  cwd?: string
}

let input: HookInput
try {
  input = JSON.parse(await Bun.stdin.text()) as HookInput
} catch {
  process.exit(0)
}
// A host that does not send the field loaded this config as a foreign one and
// would be gated on every stop: Cursor reads .claude/settings.json hooks too, and
// its own hook in .cursor/hooks.json owns the turn there.
if (typeof input.stop_hook_active !== 'boolean') {
  process.exit(0)
}

let cli: typeof import('@guren/cli')
try {
  cli = await import('@guren/cli')
} catch {
  // An unrunnable gate is not a passed one.
  console.error('guren gate could not run: @guren/cli is not resolvable from this app (run `bun install`).')
  process.exit(2)
}

const installed = resolve(import.meta.dir, '../..')

/** Both sides resolved: on macOS a temp dir's real path is `/private/var/...` while the cwd may read `/var/...`. */
function real(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** `undefined` when git is missing, fails, or `installed` is in no repository. */
function gitOutput(args: string[]): string | undefined {
  try {
    const run = Bun.spawnSync(['git', ...args], { cwd: installed, stdout: 'pipe', stderr: 'ignore' })
    return run.exitCode === 0 ? run.stdout.toString() : undefined
  } catch {
    return undefined
  }
}

/** This app's directory in each worktree of its repository; a monorepo app is not the git root. */
function worktreeApps(): Set<string> {
  const prefix = gitOutput(['rev-parse', '--show-prefix'])?.replace(/\r?\n$/, '')
  const list = gitOutput(['worktree', 'list', '--porcelain'])
  if (prefix === undefined || list === undefined) return new Set()
  return new Set(list.split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => real(join(line.slice('worktree '.length), prefix))))
}

/**
 * The app to gate: the nearest ancestor of the session cwd holding this script that is this
 * app or its place in another worktree of the repository, else the script's grandparent
 * (`<app>/.claude/hooks/`, `.codex/hooks/`). Claude Code runs the project dir's copy while the
 * cwd may be a subdirectory or a worktree it entered, whose tree is the one to judge. Another
 * tree holding the script is passed over: its package.json scripts would run here.
 */
function appRoot(cwd: unknown): string {
  const self = relative(installed, import.meta.path)
  if (typeof cwd === 'string' && isAbsolute(cwd)) {
    let worktrees: Set<string> | undefined
    for (let dir = cwd; ; dir = dirname(dir)) {
      if (existsSync(join(dir, self))) {
        if (real(dir) === real(installed)) return dir
        worktrees ??= worktreeApps()
        if (worktrees.has(real(dir))) return dir
      }
      if (dirname(dir) === dir) break
    }
  }
  return installed
}

const root = appRoot(input.cwd)

// The gate blocks once per stop; the plan step counts its own continuations in state.
if (!input.stop_hook_active) {
  const findings = await cli.stopGateFindings(root)
  // null when the tree is clean, so a turn that ends by committing is not gated
  // here: run `guren gate` before committing.
  if (findings !== null) {
    console.error(findings)
    process.exit(2)
  }
}

const plan = await cli.planStopHookFindings(root, { stopHookActive: input.stop_hook_active })
if (plan.message) {
  console.error(plan.message)
}
process.exit(plan.block ? 2 : 0)
