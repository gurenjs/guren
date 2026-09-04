import { spawn } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { resolve, relative, sep } from 'node:path'

/**
 * Runs a git command in `cwd` and returns stdout split into non-empty lines, or
 * `null` if git is unavailable, `cwd` isn't a repo, or the command fails.
 */
export function runGit(cwd: string, args: string[]): Promise<string[] | null> {
  return new Promise((resolvePromise) => {
    let proc
    try {
      proc = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      resolvePromise(null)
      return
    }

    let stdout = ''
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8')
    })
    proc.on('error', () => resolvePromise(null))
    proc.on('close', (code) => {
      if (code !== 0) {
        resolvePromise(null)
        return
      }
      resolvePromise(
        stdout
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
      )
    })
  })
}

/**
 * Files changed relative to the merge base with `main`/`origin/main`, plus
 * uncommitted and untracked changes, as POSIX paths relative to `cwd` (which may
 * be a subdirectory of the git root). `null` outside a git repository: callers
 * treat it as "don't filter" — this is a speed optimization, not a gate.
 */
export async function getChangedFiles(cwd: string): Promise<Set<string> | null> {
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

  const [committed, uncommitted, untracked] = await Promise.all([
    mergeBase ? runGit(absoluteCwd, ['diff', '--name-only', mergeBase, 'HEAD']) : Promise.resolve([]),
    runGit(absoluteCwd, ['diff', '--name-only', 'HEAD']),
    runGit(absoluteCwd, ['ls-files', '--others', '--exclude-standard']),
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

  return result
}
