/**
 * The change boundary (RFC 0040 §3): `resolveChange()` is the one reading of what a change is, and
 * `openChange()` reads both of its sides from git objects, never from the working tree.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { runGitRaw } from '../changed-files'
import { CliError } from '../cli-error'

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed'
export type ChangeSide = 'base' | 'head'

export interface ChangedPath {
  /** App-relative and POSIX; relative to the repository root when `outsideApp` is set. */
  path: string
  status: ChangeStatus
  /** `renamed` only: the path at the merge base. */
  oldPath?: string
  /** The path is not under the application root the command ran in. */
  outsideApp?: true
}

export interface ResolvedChange {
  /** Full SHAs, as resolved in this clone. */
  base: string
  head: string
  mergeBase: string
  paths: ChangedPath[]
}

/** Both sides of a change, read from git objects. Paths are app-relative. */
export interface ChangeReader {
  read(side: ChangeSide, path: string): Promise<string | null>
  paths(side: ChangeSide): Promise<ReadonlySet<string>>
  /** The files of a side whose content carries `needle` literally. */
  containing(side: ChangeSide, needle: string): Promise<string[]>
  /** A directory holding those files of a side at their own paths, for a reader that takes a directory. */
  materialize(side: ChangeSide, paths: readonly string[]): Promise<string>
}

const SHA_PATTERN = /^[0-9a-f]{7,64}$/

async function commitSha(cwd: string, role: string, value: string): Promise<string> {
  if (!SHA_PATTERN.test(value)) {
    throw new CliError(`--${role} takes a commit SHA (7 to 64 hex characters), not "${value}": a branch name moves, and the record names the commits it read.`)
  }
  const sha = (await runGitRaw(cwd, ['rev-parse', '--verify', '--quiet', `${value}^{commit}`]))?.trim()
  if (!sha) {
    throw new CliError(`The ${role} commit ${value} is not in this clone (or ${cwd} is not a git repository). Fetch it first; on GitHub Actions, check out with fetch-depth: 0.`)
  }
  return sha
}

const STATUS_BY_LETTER: Record<string, ChangeStatus> = { A: 'added', M: 'modified', T: 'modified', D: 'deleted', R: 'renamed' }

/** `git diff --name-status -z`: a status, then one path, or two after a rename. */
function parseNameStatus(output: string, prefix: string): ChangedPath[] {
  const fields = output.split('\0')
  const paths: ChangedPath[] = []
  const place = (rootRelative: string): Pick<ChangedPath, 'path' | 'outsideApp'> =>
    rootRelative.startsWith(prefix) ? { path: rootRelative.slice(prefix.length) } : { path: rootRelative, outsideApp: true }
  for (let index = 0; index < fields.length; ) {
    const letter = fields[index++]![0]
    if (letter === undefined) continue
    const status = STATUS_BY_LETTER[letter]
    if (status === undefined) throw new CliError(`git reported a change status this reader does not know: ${letter}`)
    if (status !== 'renamed') {
      paths.push({ ...place(fields[index++]!), status })
      continue
    }
    const from = place(fields[index++]!)
    const to = place(fields[index++]!)
    // A move across the application's edge is a removal on one side and an addition on the other.
    if (from.outsideApp === to.outsideApp) paths.push({ ...to, status, oldPath: from.path })
    else paths.push({ ...from, status: 'deleted' }, { ...to, status: 'added' })
  }
  return paths
}

/**
 * The change between two commits of this clone: the merge base computed from them and each path
 * with its status. An absent commit or history refuses; it is never read as an empty change.
 */
export async function resolveChange(cwd: string, base: string, head: string): Promise<ResolvedChange> {
  const [baseSha, headSha] = [await commitSha(cwd, 'base', base), await commitSha(cwd, 'head', head)]
  const mergeBase = (await runGitRaw(cwd, ['merge-base', baseSha, headSha]))?.trim()
  if (!mergeBase) {
    throw new CliError(`${baseSha} and ${headSha} share no history in this clone, so the change between them cannot be read. A shallow clone does this: fetch the full history (fetch-depth: 0).`)
  }
  const prefix = (await runGitRaw(cwd, ['rev-parse', '--show-prefix']))?.trim() ?? ''
  const diff = await runGitRaw(cwd, ['diff', '--name-status', '-z', '-M', mergeBase, headSha])
  if (diff === null) throw new CliError(`git could not list the changes between ${mergeBase} and ${headSha}.`)
  return { base: baseSha, head: headSha, mergeBase, paths: parseNameStatus(diff, prefix) }
}

/** Reads the two sides of `change` from git objects. `dispose()` removes what `materialize()` wrote. */
export function openChange(cwd: string, change: Pick<ResolvedChange, 'mergeBase' | 'head'>): { reader: ChangeReader; dispose: () => Promise<void> } {
  const rev = (side: ChangeSide): string => (side === 'base' ? change.mergeBase : change.head)
  const trees = new Map<ChangeSide, Promise<ReadonlySet<string>>>()
  const texts = new Map<string, Promise<string | null>>()
  let scratch: Promise<string> | undefined

  const reader: ChangeReader = {
    read(side, path) {
      const key = `${side}\0${path}`
      let text = texts.get(key)
      if (!text) texts.set(key, (text = runGitRaw(cwd, ['show', `${rev(side)}:./${path}`])))
      return text
    },
    paths(side) {
      let tree = trees.get(side)
      if (!tree) {
        tree = runGitRaw(cwd, ['ls-tree', '-r', '--name-only', '-z', rev(side)]).then((output) => {
          if (output === null) throw new CliError(`git could not list the files of ${rev(side)}.`)
          return new Set(output.split('\0').filter((path) => path.length > 0))
        })
        trees.set(side, tree)
      }
      return tree
    },
    async containing(side, needle) {
      // Exit 1 is "no match", which runGitRaw reports as it does a failure; both read as no file here.
      const output = await runGitRaw(cwd, ['grep', '-l', '-z', '-I', '-F', '-e', needle, rev(side), '--', '.'])
      const marker = `${rev(side)}:`
      return (output ?? '').split('\0').filter((entry) => entry.length > 0).map((entry) => (entry.startsWith(marker) ? entry.slice(marker.length) : entry))
    },
    async materialize(side, paths) {
      const dir = join(await (scratch ??= mkdtemp(join(tmpdir(), 'guren-change-'))), side)
      await mkdir(dir, { recursive: true })
      for (const path of paths) {
        const text = await reader.read(side, path)
        if (text === null) continue
        await mkdir(dirname(join(dir, path)), { recursive: true })
        await writeFile(join(dir, path), text)
      }
      return dir
    },
  }

  return {
    reader,
    async dispose() {
      if (scratch) await rm(await scratch, { recursive: true, force: true })
    },
  }
}
