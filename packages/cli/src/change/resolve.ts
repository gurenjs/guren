/**
 * The change boundary (RFC 0040 §3): `resolveChange()` is the one reading of what a change is, and
 * `openChange()` reads both of its sides from git objects, never from the working tree.
 */
import { spawn } from 'node:child_process'
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
  /** Set when either side is not a regular file: git gives a link's target for its content, and a submodule has none. */
  kind?: 'symlink' | 'submodule'
}

export interface ResolvedChange {
  /** Full SHAs, as resolved in this clone. */
  base: string
  head: string
  mergeBase: string
  /** The application root below the repository root, with its trailing slash; empty at the root. */
  appPrefix: string
  paths: ChangedPath[]
}

/** Both sides of a change, read from git objects. Paths are app-relative. */
export interface ChangeReader {
  /** `null` only for a path the side does not have; a read git fails throws. */
  read(side: ChangeSide, path: string): Promise<string | null>
  /** {@link read} for a path given from the repository root, which reaches outside the application. */
  readOutside(side: ChangeSide, path: string): Promise<string | null>
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
  // A ref named in hex (`deadbeef1`) resolves too, to a commit its name is no prefix of.
  if (!sha?.startsWith(value)) {
    throw new CliError(`The ${role} commit ${value} is not in this clone (or ${cwd} is not a git repository). Fetch it first; on GitHub Actions, check out with fetch-depth: 0.`)
  }
  return sha
}

const STATUS_BY_LETTER: Record<string, ChangeStatus> = { A: 'added', M: 'modified', T: 'modified', D: 'deleted', R: 'renamed' }

const KIND_BY_MODE: Record<string, ChangedPath['kind']> = { '120000': 'symlink', '160000': 'submodule' }

/** `git diff --raw -z`: `:<mode> <mode> <sha> <sha> <status>`, then one path, or two after a rename. */
function parseRawDiff(output: string, prefix: string): ChangedPath[] {
  const fields = output.split('\0')
  const paths: ChangedPath[] = []
  const place = (rootRelative: string): Pick<ChangedPath, 'path' | 'outsideApp'> =>
    rootRelative.startsWith(prefix) ? { path: rootRelative.slice(prefix.length) } : { path: rootRelative, outsideApp: true }
  for (let index = 0; index < fields.length; ) {
    const meta = fields[index++]!
    if (meta.length === 0) continue
    const [before, after, , , letters] = meta.slice(1).split(' ')
    const status = STATUS_BY_LETTER[letters?.[0] ?? '']
    if (!meta.startsWith(':') || status === undefined) throw new CliError(`git reported a change this reader does not know: ${meta}`)
    const kind = KIND_BY_MODE[after ?? ''] ?? KIND_BY_MODE[before ?? '']
    const special = kind ? { kind } : {}
    if (status !== 'renamed') {
      paths.push({ ...place(fields[index++]!), status, ...special })
      continue
    }
    const from = place(fields[index++]!)
    const to = place(fields[index++]!)
    // A move across the application's edge is a removal on one side and an addition on the other.
    if (from.outsideApp === to.outsideApp) paths.push({ ...to, status, oldPath: from.path, ...special })
    else paths.push({ ...from, status: 'deleted', ...special }, { ...to, status: 'added', ...special })
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
  // Only git's own newline goes: a directory may be named with a leading space.
  const prefix = (await runGitRaw(cwd, ['rev-parse', '--show-prefix']))?.replace(/\n$/, '') ?? ''
  // `diff.relative` would print these paths from the working directory, and `diff.ignoreSubmodules` drop a moved pointer.
  const diff = await runGitRaw(cwd, ['diff', '--raw', '-z', '-M', '--abbrev=40', '--no-relative', '--ignore-submodules=none', mergeBase, headSha])
  if (diff === null) throw new CliError(`git could not list the changes between ${mergeBase} and ${headSha}.`)
  return { base: baseSha, head: headSha, mergeBase, appPrefix: prefix, paths: parseRawDiff(diff, prefix) }
}

/** Runs git and keeps its exit code, which `git grep` answers "no match" with. */
function gitResult(cwd: string, args: string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = []
    const proc = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    proc.on('error', () => resolvePromise({ code: null, stdout: '' }))
    proc.on('close', (code) => resolvePromise({ code, stdout: Buffer.concat(chunks).toString('utf-8') }))
  })
}

/** Reads the two sides of `change` from git objects. `dispose()` removes what `materialize()` wrote. */
export function openChange(cwd: string, change: Pick<ResolvedChange, 'mergeBase' | 'head' | 'appPrefix'>): { reader: ChangeReader; dispose: () => Promise<void> } {
  const rev = (side: ChangeSide): string => (side === 'base' ? change.mergeBase : change.head)
  const prefix = change.appPrefix
  const fullTrees = new Map<ChangeSide, Promise<ReadonlySet<string>>>()
  const appTrees = new Map<ChangeSide, Promise<ReadonlySet<string>>>()
  const texts = new Map<string, Promise<string | null>>()
  let scratch: Promise<string> | undefined

  const fullTree = (side: ChangeSide): Promise<ReadonlySet<string>> => {
    let tree = fullTrees.get(side)
    if (!tree) {
      tree = runGitRaw(cwd, ['ls-tree', '-r', '-z', '--full-tree', rev(side)]).then((output) => {
        if (output === null) throw new CliError(`git could not list the files of ${rev(side)}.`)
        // `<mode> <type> <sha>\t<path>`; a submodule's entry is a commit, which holds no file to read.
        const files = output.split('\0').filter((entry) => entry.length > 0 && !entry.startsWith('160000 '))
        return new Set(files.map((entry) => entry.slice(entry.indexOf('\t') + 1)))
      })
      fullTrees.set(side, tree)
    }
    return tree
  }
  // The tree says whether a path exists, so a failed read (a blob a partial clone cannot fetch) is never read as an absent file.
  const readFromRoot = (side: ChangeSide, rootPath: string): Promise<string | null> => {
    const key = `${side}\0${rootPath}`
    let text = texts.get(key)
    if (!text) {
      text = fullTree(side).then(async (tree) => {
        if (!tree.has(rootPath)) return null
        const content = await runGitRaw(cwd, ['show', `${rev(side)}:${rootPath}`])
        if (content === null) throw new CliError(`git could not read ${rootPath} at ${rev(side)}, which that commit has. A partial clone that cannot reach its remote does this.`)
        return content
      })
      texts.set(key, text)
    }
    return text
  }

  const reader: ChangeReader = {
    read: (side, path) => readFromRoot(side, `${prefix}${path}`),
    readOutside: (side, path) => readFromRoot(side, path),
    paths(side) {
      let tree = appTrees.get(side)
      if (!tree) appTrees.set(side, (tree = fullTree(side).then((all) => new Set([...all].filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length))))))
      return tree
    },
    async containing(side, needle) {
      // `grep.fullName` would print these paths from the repository root.
      const { code, stdout } = await gitResult(cwd, ['grep', '-l', '-z', '-I', '-F', '--no-full-name', '-e', needle, rev(side), '--', '.'])
      if (code !== 0 && code !== 1) throw new CliError(`git could not search the files of ${rev(side)} for ${needle}.`)
      const marker = `${rev(side)}:`
      return stdout.split('\0').filter((entry) => entry.length > 0).map((entry) => (entry.startsWith(marker) ? entry.slice(marker.length) : entry))
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
