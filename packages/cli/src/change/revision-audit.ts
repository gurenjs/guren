/**
 * The audit of each side of a change (RFC 0040 §3): a revision is exported from git objects into
 * a temp directory, given the install that is on disk when its lockfile is that install's, and
 * audited by this CLI in a child. It runs the application's code under the caller's environment,
 * as `guren audit` does.
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { promisify } from 'node:util'

import type { AuditReport } from '../audit'
import { cliEntry } from '../cli-entry'
import type { ChangeSide, ResolvedChange } from './resolve'

const execute = promisify(execFile)

const LOCKFILES = ['bun.lock', 'bun.lockb']
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
const CODEGEN_TIMEOUT_MS = 60_000
const AUDIT_TIMEOUT_MS = 120_000
const OUTPUT_LIMIT = 64 * 1024 * 1024

type RevisionAudit = { report: AuditReport } | { unavailable: string }

/**
 * The audit of both sides, or why the two could not be compared; never one side alone.
 * `loadedCode` is set once a child ran in an export, whether or not it reported.
 */
export type ChangeAudits = { base: AuditReport; head: AuditReport } | { unavailable: string; loadedCode?: true }

/** The repository root, then each directory down to the application root, each with its trailing slash. */
function installDirectories(appPrefix: string): string[] {
  const segments = appPrefix.split('/').filter((segment) => segment.length > 0)
  return ['', ...segments.map((_, index) => `${segments.slice(0, index + 1).join('/')}/`)]
}

const git = (cwd: string, args: string[]): Promise<string | undefined> =>
  execute('git', args, { cwd, maxBuffer: OUTPUT_LIMIT }).then((result) => result.stdout.replace(/\n$/, ''), () => undefined)

/**
 * Why the install on disk does not serve an export: a package that resolves into this repository
 * (a workspace member, a `link:` or `file:` dependency) runs the working tree's copy at both
 * commits. Read from the manifest's own words and from the top-level links; a link nested inside
 * an installed package is not walked.
 */
async function repositoryPackage(root: string, directory: string): Promise<string | undefined> {
  const manifest: unknown = await readFile(join(root, directory, 'package.json'), 'utf8').then(JSON.parse, () => undefined)
  if (typeof manifest === 'object' && manifest !== null) {
    const fields = manifest as Record<string, unknown>
    if (fields.workspaces !== undefined) return `${directory}package.json declares workspaces`
    for (const field of DEPENDENCY_FIELDS) {
      const local = Object.entries((fields[field] as Record<string, unknown> | undefined) ?? {}).find(([, spec]) => typeof spec === 'string' && /^(?:workspace|link|file):/.test(spec))
      if (local) return `${local[0]} is installed from ${String(local[1])}`
    }
  }
  const modules = join(root, directory, 'node_modules')
  const [repository, entries] = [await realpath(root), await readdir(modules).catch(() => [] as string[])]
  const names = (await Promise.all(entries.map(async (entry) => (entry.startsWith('@') ? (await readdir(join(modules, entry)).catch(() => [] as string[])).map((name) => `${entry}/${name}`) : [entry])))).flat()
  for (const name of names) {
    if (!(await lstat(join(modules, name)).catch(() => undefined))?.isSymbolicLink()) continue
    const target = await realpath(join(modules, name)).catch(() => undefined)
    if (target?.startsWith(`${repository}${sep}`) && !target.includes(`${sep}node_modules${sep}`)) return `${name} is installed as a link into this repository`
  }
  return undefined
}

/**
 * Writes the regular files of `rev` under `tree`, each as its blob and nothing else: a checkout
 * would run the smudge and end-of-line filters, and what was audited would not be what was
 * committed. Returns why the commit cannot be exported, when it cannot.
 */
export async function exportBlobs(root: string, rev: string, tree: string, appPrefix: string, select?: (path: string) => boolean): Promise<string | undefined> {
  const listing = await git(root, ['ls-tree', '-r', '-z', '--full-tree', rev])
  if (listing === undefined) return 'git could not list its files'
  const entries = listing.split('\0').filter((entry) => entry.length > 0).map((entry) => {
    const [mode, , sha] = entry.slice(0, entry.indexOf('\t')).split(' ')
    return { mode: mode!, sha: sha!, path: entry.slice(entry.indexOf('\t') + 1) }
  }).filter((entry) => !select || select(entry.path))
  // A tracked link inside the application (`.guren` pointing into the install) would carry a child's writes out of the export.
  const link = entries.find((entry) => entry.mode === '120000' && entry.path.startsWith(appPrefix))
  if (link) return `it tracks the symlink ${link.path}, which an export would follow out of itself`
  const files = entries.filter((entry) => entry.mode.startsWith('100'))

  const batch = spawn('git', ['cat-file', '--batch'], { cwd: root, stdio: ['pipe', 'pipe', 'ignore'] })
  batch.stdin.end(`${files.map((file) => file.sha).join('\n')}\n`)
  let buffer = Buffer.alloc(0)
  let written = 0
  let size: number | undefined
  for await (const chunk of batch.stdout as AsyncIterable<Buffer>) {
    buffer = Buffer.concat([buffer, chunk])
    while (written < files.length) {
      if (size === undefined) {
        const end = buffer.indexOf(0x0a)
        if (end === -1) break
        // `<sha> blob <size>`, or `<sha> missing` for a blob a partial clone does not hold.
        size = Number(buffer.subarray(0, end).toString().split(' ')[2])
        if (!Number.isInteger(size)) return `git could not read ${files[written]!.path}`
        buffer = buffer.subarray(end + 1)
      }
      if (buffer.length < size + 1) break
      const target = join(tree, files[written]!.path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, buffer.subarray(0, size))
      buffer = buffer.subarray(size + 1)
      size = undefined
      written++
    }
  }
  return written === files.length ? undefined : 'git did not return every file'
}

function parseReport(stdout: string): AuditReport | undefined {
  // A module the application imports may print ahead of the report.
  const start = stdout.lastIndexOf('{\n  "cwd":')
  try {
    const value: unknown = JSON.parse(start === -1 ? stdout : stdout.slice(start))
    return typeof value === 'object' && value !== null && Array.isArray((value as { findings?: unknown }).findings) ? (value as AuditReport) : undefined
  } catch {
    return undefined
  }
}

async function auditExport(appDir: string): Promise<RevisionAudit> {
  const run = (args: string[], timeout: number) => execute(process.execPath, [cliEntry(), ...args, '--app', appDir], { cwd: appDir, timeout, maxBuffer: OUTPUT_LIMIT })
  // Where `.guren/` is not committed, the routes file does not load without it; a codegen that fails shows in the audit.
  await run(['codegen'], CODEGEN_TIMEOUT_MS).catch(() => undefined)
  let stdout: string
  try {
    stdout = (await run(['audit', '--json', '--no-deps'], AUDIT_TIMEOUT_MS)).stdout
  } catch (error) {
    // Exit 1 is an audit with failures, which still prints its report.
    const failure = error as { code?: unknown; killed?: boolean; stdout?: unknown }
    if (failure.code !== 1 || failure.killed || typeof failure.stdout !== 'string') return { unavailable: 'the audit did not finish there' }
    stdout = failure.stdout
  }
  const report = parseReport(stdout)
  return report ? { report } : { unavailable: 'the audit printed no report there' }
}

/**
 * Audits both sides of `change`, or neither. A commit whose lockfile is not the one installed on
 * disk is not audited: its dependencies are not here, and another install's would answer for the
 * wrong code.
 */
export async function auditChangeRevisions(cwd: string, change: ResolvedChange): Promise<ChangeAudits> {
  const unavailable = (reason: string): ChangeAudits => ({ unavailable: reason })
  const root = await git(cwd, ['rev-parse', '--show-toplevel'])
  if (root === undefined) return unavailable('git could not name the repository root')
  const directories = installDirectories(change.appPrefix)
  const installs = directories.filter((directory) => existsSync(join(root, directory, 'node_modules')))
  if (installs.length === 0) return unavailable('no node_modules is installed here; run bun install')
  for (const directory of directories) {
    const local = await repositoryPackage(root, directory)
    if (local) return unavailable(`${local}, so each commit's own copy of that code would not be the one that runs`)
  }

  // Blob ids, since a binary `bun.lockb` does not survive being read as text.
  const lockfiles = directories.flatMap((directory) => LOCKFILES.map((lockfile) => `${directory}${lockfile}`))
  const installed = new Map(await Promise.all(lockfiles.map(async (path) => [path, existsSync(join(root, path)) ? await git(root, ['hash-object', '--no-filters', '--', path]) : undefined] as const)))
  if ([...installed.values()].every((id) => id === undefined)) return unavailable('no lockfile here says which install this is')
  const revisions = { head: change.head, base: change.mergeBase }
  for (const side of ['head', 'base'] as const) {
    for (const path of lockfiles) {
      if ((await git(root, ['rev-parse', '--verify', '--quiet', `${revisions[side]}:${path}`])) !== installed.get(path)) {
        return unavailable(`the ${side} was not audited: ${path} at ${revisions[side].slice(0, 12)} is not the lockfile installed here`)
      }
    }
  }

  const scratch = await mkdtemp(join(tmpdir(), 'guren-change-audit-'))
  const exportSide = async (side: ChangeSide): Promise<string | undefined> => {
    const tree = join(scratch, side)
    try {
      const refused = await exportBlobs(root, revisions[side], tree, change.appPrefix)
      if (refused) return refused
      for (const directory of installs) {
        await mkdir(join(tree, directory), { recursive: true })
        if (!existsSync(join(tree, directory, 'node_modules'))) await symlink(join(root, directory, 'node_modules'), join(tree, directory, 'node_modules'), 'junction')
      }
      return undefined
    } catch (error) {
      return (error as Error).message.split('\n')[0]
    }
  }
  try {
    // Both exports stand before either runs: a commit that cannot be exported leaves no code loaded.
    for (const side of ['head', 'base'] as const) {
      const refused = await exportSide(side)
      if (refused !== undefined) return unavailable(`the ${side} was not audited: ${revisions[side].slice(0, 12)} could not be exported: ${refused}`)
    }
    const [base, head] = [await auditExport(join(scratch, 'base', change.appPrefix)), await auditExport(join(scratch, 'head', change.appPrefix))]
    if ('unavailable' in head) return { unavailable: `the head was not audited: ${head.unavailable}`, loadedCode: true }
    if ('unavailable' in base) return { unavailable: `the base was not audited: ${base.unavailable}`, loadedCode: true }
    return { base: base.report, head: head.report }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
