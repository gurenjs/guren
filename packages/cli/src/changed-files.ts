import { spawn } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { resolve, relative, sep } from 'node:path'

/**
 * Runs a git command in `cwd` and returns its stdout untouched, or `null` if git
 * is unavailable, `cwd` isn't a repo, or the command fails. For `-z` output,
 * whose paths a trim or a line split would corrupt.
 */
export function runGitRaw(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolvePromise) => {
    let proc
    try {
      proc = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      resolvePromise(null)
      return
    }

    const chunks: Buffer[] = []
    proc.stdout?.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })
    proc.on('error', () => resolvePromise(null))
    proc.on('close', (code) => {
      resolvePromise(code === 0 ? Buffer.concat(chunks).toString('utf-8') : null)
    })
  })
}

/**
 * Runs a git command in `cwd` and returns stdout split into non-empty lines, or
 * `null` if git is unavailable, `cwd` isn't a repo, or the command fails.
 */
export async function runGit(cwd: string, args: string[]): Promise<string[] | null> {
  const stdout = await runGitRaw(cwd, args)
  if (stdout === null) return null
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/**
 * Files changed relative to the merge base with `main`/`origin/main`, plus
 * uncommitted and untracked changes, as POSIX paths relative to `cwd` (which may
 * be a subdirectory of the git root). `null` outside a git repository: callers
 * treat it as "don't filter" — this is a speed optimization, not a gate.
 */
export async function getChangedFiles(cwd: string): Promise<Set<string> | null> {
  return (await getChangedFilesFromBase(cwd))?.files ?? null
}

/**
 * `getChangedFiles()` with the merge base it diffed against, undefined when
 * neither `origin/main` nor `main` shares history with HEAD, in which case
 * `files` holds only uncommitted and untracked changes. `complete` is false
 * when one of the git listings failed, so `files` may be short.
 */
export async function getChangedFilesFromBase(cwd: string): Promise<{ files: Set<string>; mergeBase?: string; complete: boolean } | null> {
  // realpath, not just resolve: git reports --show-toplevel through the real
  // path, and on macOS /tmp is a symlink to /private/tmp.
  const absoluteCwd = await realpath(resolve(cwd)).catch(() => resolve(cwd))
  const rootLines = await runGit(absoluteCwd, ['rev-parse', '--show-toplevel'])
  const gitRoot = rootLines?.[0]
  if (!gitRoot) return null

  let mergeBase = (await runGit(absoluteCwd, ['merge-base', 'HEAD', 'origin/main']))?.[0]
  if (!mergeBase) {
    mergeBase = (await runGit(absoluteCwd, ['merge-base', 'HEAD', 'main']))?.[0]
  }

  // A repository with no commit has no HEAD to diff against; everything tracked is then in the index.
  const hasHead = (await runGit(absoluteCwd, ['rev-parse', '--verify', '--quiet', 'HEAD'])) !== null
  const [committed, uncommitted, untracked] = await Promise.all([
    mergeBase ? runGit(absoluteCwd, ['diff', '--name-only', mergeBase, 'HEAD']) : Promise.resolve([]),
    runGit(absoluteCwd, hasHead ? ['diff', '--name-only', 'HEAD'] : ['diff', '--name-only', '--cached']),
    runGit(absoluteCwd, ['ls-files', '--others', '--exclude-standard']),
  ])

  const result = underCwd(gitRoot, absoluteCwd, [...(committed ?? []), ...(uncommitted ?? []), ...(untracked ?? [])])

  // A listing git failed to produce is missing files, not a list of none.
  const complete = (mergeBase === undefined || committed !== null) && uncommitted !== null && untracked !== null
  return { files: result, mergeBase, complete }
}

/**
 * This session's work only: uncommitted and untracked files, as POSIX paths relative
 * to `cwd`, without the branch's earlier commits. `null` outside a git repository.
 */
export async function getUncommittedFiles(cwd: string): Promise<Set<string> | null> {
  const absoluteCwd = await realpath(resolve(cwd)).catch(() => resolve(cwd))
  const gitRoot = (await runGit(absoluteCwd, ['rev-parse', '--show-toplevel']))?.[0]
  if (!gitRoot) return null
  const hasHead = (await runGit(absoluteCwd, ['rev-parse', '--verify', '--quiet', 'HEAD'])) !== null
  const [uncommitted, untracked] = await Promise.all([
    runGit(absoluteCwd, hasHead ? ['diff', '--name-only', 'HEAD'] : ['diff', '--name-only', '--cached']),
    runGit(absoluteCwd, ['ls-files', '--others', '--exclude-standard']),
  ])
  return underCwd(gitRoot, absoluteCwd, [...(uncommitted ?? []), ...(untracked ?? [])])
}

/** Git-root-relative paths (as `diff --name-only` prints them) re-rooted at `cwd`, dropping those outside it. */
function underCwd(gitRoot: string, absoluteCwd: string, gitRootRelativePaths: Iterable<string>): Set<string> {
  const result = new Set<string>()
  for (const gitRootRelativePath of gitRootRelativePaths) {
    const cwdRelativePath = relative(absoluteCwd, resolve(gitRoot, gitRootRelativePath))
    if (cwdRelativePath.startsWith('..')) continue // outside cwd (e.g. a different monorepo package)
    result.add(cwdRelativePath.split(sep).join('/'))
  }
  return result
}

/** Any file that could hold a route's params schema or change what the app's modules evaluate to. */
const SOURCE_FILE_PATTERN = /\.(ts|tsx|mts|js|jsx|mjs)$/

/** Whether a run's changed files (null: a full run) could change what the app's modules evaluate to. */
export function changesSource(changedFiles: ReadonlySet<string> | null | undefined): boolean {
  return !changedFiles || [...changedFiles].some((file) => SOURCE_FILE_PATTERN.test(file))
}
