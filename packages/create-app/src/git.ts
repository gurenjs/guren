import { spawnSync } from 'node:child_process'

/**
 * How long the scaffolder waits on `git` before giving up.
 *
 * The child gets no terminal, so anything that decides to prompt — a signing
 * passphrase, a credential helper, a stalled name lookup while git guesses the
 * committer identity — would block forever with the app already written to
 * disk. Bounding it turns that into the caller's manual-recovery warning.
 * Generous enough that an ordinary commit on a loaded machine never trips it.
 */
export const GIT_TIMEOUT_MS = 30_000

export interface GitCommandOptions {
  /** Budget for the whole call, not per subprocess; only overridden by tests. */
  timeoutMs?: number
}

/** Which step failed, so the caller can explain what to finish by hand. */
export type GitInitFailure = 'init' | 'add' | 'commit'

export type GitInitResult = { ok: true } | { ok: false; failedStep: GitInitFailure }

function runGit(cwd: string, args: string[], timeoutMs: number): boolean {
  const result = spawnSync('git', args, {
    cwd,
    stdio: 'pipe',
    // `env` is passed explicitly (not omitted) so a caller that sets
    // GIT_AUTHOR_*/GIT_COMMITTER_* on process.env just before this runs is
    // guaranteed to reach the child process. GIT_TERMINAL_PROMPT keeps git
    // from waiting on a terminal this child does not have.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    // Never zero or negative: spawnSync treats that as "no timeout".
    timeout: Math.max(1, timeoutMs),
    // SIGTERM leaves a git blocked in a syscall alive, and spawnSync would go
    // on blocking with it.
    killSignal: 'SIGKILL',
  })

  // A timed-out child reports `status: null`, so this covers both a git that
  // failed and a git that had to be killed.
  return result.status === 0
}

export function isInsideGitWorkTree(cwd: string, options: GitCommandOptions = {}): boolean {
  const result = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd,
    stdio: 'pipe',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    timeout: Math.max(1, options.timeoutMs ?? GIT_TIMEOUT_MS),
    killSignal: 'SIGKILL',
  })
  // `status === 0` first: a missing git binary leaves stdout null, and the
  // short-circuit is what keeps this a graceful "not a repo" rather than a throw.
  return result.status === 0 && result.stdout.toString().trim() === 'true'
}

export function initGitRepository(cwd: string, options: GitCommandOptions = {}): GitInitResult {
  // One deadline across all three steps rather than one budget each: the caller
  // needs a bound on the whole call, and three independent budgets is three
  // times the wait it thinks it agreed to.
  const deadline = Date.now() + (options.timeoutMs ?? GIT_TIMEOUT_MS)

  // Plain `git init` so the user's own init.defaultBranch decides the branch name.
  const steps: Array<{ step: GitInitFailure; args: string[] }> = [
    { step: 'init', args: ['init'] },
    { step: 'add', args: ['add', '-A'] },
    { step: 'commit', args: ['commit', '-m', 'chore: initial commit'] },
  ]

  for (const { step, args } of steps) {
    if (!runGit(cwd, args, deadline - Date.now())) {
      return { ok: false, failedStep: step }
    }
  }

  return { ok: true }
}
