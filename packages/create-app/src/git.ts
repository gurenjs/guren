import { spawnSync, type SpawnSyncReturns } from 'node:child_process'

/**
 * How long the scaffolder waits on `git` before giving up.
 *
 * The bound is tied to how these children are run, not applied to every child
 * the scaffolder spawns. `bun install` and the app's own CLI inherit the
 * terminal: they can answer a prompt, they show progress, and a long one is
 * visibly working. These run with `stdio: 'pipe'` and no terminal, where a
 * signing passphrase prompt, a credential helper, or a stalled name lookup
 * while git guesses the committer identity waits on input that can never
 * arrive — silently, with the app already written to disk. Generous enough
 * that an ordinary commit on a loaded machine never trips it.
 */
export const GIT_TIMEOUT_MS = 30_000

export interface GitCommandOptions {
  /**
   * Budget for the whole call rather than for each subprocess. Exists so the
   * deadline can be exercised without waiting out the full budget.
   */
  timeoutMs?: number
}

type GitStep = 'init' | 'add' | 'commit'

export type GitInitResult =
  | { ok: true }
  /** `command` so the caller can name the step without restating its arguments. */
  | { ok: false; failedStep: GitStep; command: string }

function runGit(cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): SpawnSyncReturns<Buffer> {
  return spawnSync('git', args, {
    cwd,
    stdio: 'pipe',
    // Read at call time rather than hoisted: a caller that sets
    // GIT_AUTHOR_*/GIT_COMMITTER_* just before this runs has to reach the
    // child. GIT_TERMINAL_PROMPT keeps git from waiting on a terminal it does
    // not have.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    // spawnSync reads a non-positive timeout as "no timeout".
    timeout: Math.max(1, timeoutMs),
    // SIGTERM leaves a git blocked in a syscall alive, and spawnSync would go
    // on blocking with it.
    killSignal: 'SIGKILL',
  })
}

function wasKilledByTimeout(result: SpawnSyncReturns<Buffer>): boolean {
  return (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
}

export function isInsideGitWorkTree(cwd: string, options: GitCommandOptions = {}): boolean {
  const result = runGit(cwd, ['rev-parse', '--is-inside-work-tree'], options.timeoutMs)

  // A probe that had to be killed answers "yes". The caller uses this to
  // *decline* `git init`, so an unreadable answer should decline too — the
  // alternative is nesting a repository inside the user's checkout, which is
  // the outcome the caller calls never what they wanted.
  if (wasKilledByTimeout(result)) {
    return true
  }

  // `status === 0` first: a missing git binary leaves stdout null, and the
  // short-circuit is what keeps that a graceful "not a repo" rather than a
  // throw — `git init` then fails with its own warning.
  return result.status === 0 && result.stdout.toString().trim() === 'true'
}

export function initGitRepository(cwd: string, options: GitCommandOptions = {}): GitInitResult {
  // One deadline across all three steps rather than one budget each: the caller
  // needs a bound on the whole call, and three independent budgets is three
  // times the wait it thinks it agreed to.
  const deadline = Date.now() + (options.timeoutMs ?? GIT_TIMEOUT_MS)

  const run = (failedStep: GitStep, args: string[]): GitInitResult => {
    const remaining = deadline - Date.now()
    // Spending an exhausted budget on one more child would leave the call
    // unbounded in exactly the case the bound exists for.
    const ok = remaining > 0 && runGit(cwd, args, remaining).status === 0
    return ok ? { ok: true } : { ok: false, failedStep, command: `git ${args.join(' ')}` }
  }

  // Plain `git init` so the user's own init.defaultBranch decides the branch name.
  const init = run('init', ['init'])
  if (!init.ok) return init

  const add = run('add', ['add', '-A'])
  if (!add.ok) return add

  return run('commit', ['commit', '-m', 'chore: initial commit'])
}
