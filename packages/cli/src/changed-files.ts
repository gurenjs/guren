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

/** NUL-separated paths as git wrote them, never C-quoted (a non-ASCII path is quoted without `-z`). */
async function runGitPaths(cwd: string, args: string[]): Promise<string[] | null> {
  const stdout = await runGitRaw(cwd, [...args, '-z'])
  return stdout === null ? null : stdout.split('\0').filter((path) => path.length > 0)
}

/**
 * `getChangedFiles()` with the merge base it diffed against, undefined when
 * none of `origin/main`, `main` and `origin/HEAD` shares history with HEAD, in which case
 * `files` holds only uncommitted and untracked changes. `head` is HEAD's
 * commit, undefined before the first commit. `complete` is false when one of
 * the git listings failed, so `files` may be short.
 */
export async function getChangedFilesFromBase(
  cwd: string,
): Promise<{ files: Set<string>; mergeBase?: string; head?: string; complete: boolean } | null> {
  // realpath, not just resolve: git reports --show-toplevel through the real
  // path, and on macOS /tmp is a symlink to /private/tmp.
  const absoluteCwd = await realpath(resolve(cwd)).catch(() => resolve(cwd))
  const rootLines = await runGit(absoluteCwd, ['rev-parse', '--show-toplevel'])
  const gitRoot = rootLines?.[0]
  if (!gitRoot) return null

  // `origin/HEAD` is the remote's default branch, for a repository whose base is not called main.
  // A repository with no commit has no HEAD to diff against; everything tracked is then in the index.
  const [bases, headLines] = await Promise.all([
    Promise.all(['origin/main', 'main', 'origin/HEAD'].map((base) => runGit(absoluteCwd, ['merge-base', 'HEAD', base]))),
    runGit(absoluteCwd, ['rev-parse', '--verify', '--quiet', 'HEAD']),
  ])
  const mergeBase = bases.map((lines) => lines?.[0]).find((base) => base !== undefined)
  const head = headLines?.[0]
  const [committed, uncommitted, untracked] = await Promise.all([
    mergeBase ? runGitPaths(absoluteCwd, ['diff', '--name-only', mergeBase, 'HEAD']) : Promise.resolve([]),
    runGitPaths(absoluteCwd, head ? ['diff', '--name-only', 'HEAD'] : ['diff', '--name-only', '--cached']),
    runGitPaths(absoluteCwd, ['ls-files', '--others', '--exclude-standard']),
  ])

  const gitRootRelativePaths = new Set<string>([
    ...(committed ?? []),
    ...(uncommitted ?? []),
    ...(untracked ?? []),
  ])

  const result = new Set<string>()
  for (const gitRootRelativePath of gitRootRelativePaths) {
    const absPath = resolve(gitRoot, gitRootRelativePath)
    const cwdRelativePath = relative(absoluteCwd, absPath)
    if (cwdRelativePath.startsWith('..')) continue // outside cwd (e.g. a different monorepo package)
    result.add(cwdRelativePath.split(sep).join('/'))
  }

  // A listing git failed to produce is missing files, not a list of none.
  const complete = (mergeBase === undefined || committed !== null) && uncommitted !== null && untracked !== null
  return { files: result, mergeBase, head, complete }
}

/** Any file that could hold a route's params schema or change what the app's modules evaluate to. */
const SOURCE_FILE_PATTERN = /\.(ts|tsx|mts|js|jsx|mjs)$/

/** Whether a run's changed files (null: a full run) could change what the app's modules evaluate to. */
export function changesSource(changedFiles: ReadonlySet<string> | null | undefined): boolean {
  return !changedFiles || [...changedFiles].some((file) => SOURCE_FILE_PATTERN.test(file))
}
