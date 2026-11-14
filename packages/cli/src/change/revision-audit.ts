/**
 * The audit of each side of a change (RFC 0040 §3): a revision is exported from git objects into
 * a temp directory, given the install that is on disk when its lockfile is that install's, and
 * audited by this CLI in a child. It runs the application's code under the caller's environment,
 * as `guren audit` does.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { promisify } from 'node:util'

import type { AuditReport } from '../audit'
import { cliEntry } from '../cli-entry'
import type { ChangeReader, ChangeSide, ResolvedChange } from './resolve'

const execute = promisify(execFile)

const LOCKFILES = ['bun.lock', 'bun.lockb']
const CODEGEN_TIMEOUT_MS = 60_000
const AUDIT_TIMEOUT_MS = 120_000
const OUTPUT_LIMIT = 64 * 1024 * 1024

type RevisionAudit = { report: AuditReport } | { unavailable: string }

/** The audit of both sides, or why the two could not be compared; never one side alone. */
export type ChangeAudits = { base: AuditReport; head: AuditReport } | { unavailable: string }

/** The repository root, then each directory down to the application root, each with its trailing slash. */
function installDirectories(appPrefix: string): string[] {
  const segments = appPrefix.split('/').filter((segment) => segment.length > 0)
  return ['', ...segments.map((_, index) => `${segments.slice(0, index + 1).join('/')}/`)]
}

async function onDisk(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch(() => null)
}

/**
 * A package installed as a link into this repository (a workspace member, a `link:` dependency).
 * The link resolves in the working tree, so an export would run the tree's copy at both revisions.
 */
async function linkedFromRepository(root: string, modules: string): Promise<string | undefined> {
  const [repository, entries] = [await realpath(root), await readdir(modules).catch(() => [] as string[])]
  const names = (await Promise.all(entries.map(async (entry) => (entry.startsWith('@') ? (await readdir(join(modules, entry)).catch(() => [] as string[])).map((name) => `${entry}/${name}`) : [entry])))).flat()
  for (const name of names) {
    if (!(await lstat(join(modules, name)).catch(() => undefined))?.isSymbolicLink()) continue
    const target = await realpath(join(modules, name)).catch(() => undefined)
    if (target?.startsWith(`${repository}${sep}`) && !target.includes(`${sep}node_modules${sep}`)) return name
  }
  return undefined
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
 * Audits both sides of `change`. A side whose lockfile is not the one installed on disk is not
 * audited: its dependencies are not here, and another install's would answer for the wrong code.
 */
export async function auditChangeRevisions(cwd: string, change: ResolvedChange, reader: ChangeReader): Promise<ChangeAudits> {
  const unavailable = (reason: string): ChangeAudits => ({ unavailable: reason })
  const root = await execute('git', ['rev-parse', '--show-toplevel'], { cwd }).then((result) => result.stdout.replace(/\n$/, ''), () => undefined)
  if (root === undefined) return unavailable('git could not name the repository root')
  const directories = installDirectories(change.appPrefix)
  const installs = directories.filter((directory) => existsSync(join(root, directory, 'node_modules')))
  if (installs.length === 0) return unavailable('no node_modules is installed here; run bun install')

  for (const directory of installs) {
    const linked = await linkedFromRepository(root, join(root, directory, 'node_modules'))
    if (linked) return unavailable(`${linked} is installed as a link into this repository, so each commit's own copy of it would not be the one that runs`)
  }
  const lockfiles = directories.flatMap((directory) => LOCKFILES.map((lockfile) => `${directory}${lockfile}`))
  const installed = new Map(await Promise.all(lockfiles.map(async (path) => [path, await onDisk(join(root, path))] as const)))
  if ([...installed.values()].every((content) => content === null)) return unavailable('no lockfile here says which install this is')
  const mismatch = async (side: ChangeSide): Promise<string | undefined> => {
    for (const path of lockfiles) {
      if ((await reader.readOutside(side, path)) !== installed.get(path)) return `${path} at ${(side === 'base' ? change.mergeBase : change.head).slice(0, 12)} is not the lockfile installed here`
    }
    return undefined
  }
  // Neither side is exported unless both can be: one audit alone compares with nothing.
  for (const side of ['head', 'base'] as const) {
    const reason = await mismatch(side)
    if (reason !== undefined) return unavailable(`the ${side} was not audited: ${reason}`)
  }

  const scratch = await mkdtemp(join(tmpdir(), 'guren-change-audit-'))
  const auditSide = async (side: ChangeSide): Promise<RevisionAudit> => {
    const rev = side === 'base' ? change.mergeBase : change.head
    const tree = join(scratch, side)
    const env = { ...process.env, GIT_INDEX_FILE: join(scratch, `${side}.index`) }
    try {
      await execute('git', ['read-tree', rev], { cwd: root, env })
      await execute('git', ['checkout-index', '-a', `--prefix=${tree}/`], { cwd: root, env, maxBuffer: OUTPUT_LIMIT })
      for (const directory of installs) {
        await mkdir(join(tree, directory), { recursive: true })
        if (!existsSync(join(tree, directory, 'node_modules'))) await symlink(join(root, directory, 'node_modules'), join(tree, directory, 'node_modules'), 'junction')
      }
    } catch (error) {
      return { unavailable: `${rev.slice(0, 12)} could not be exported: ${(error as Error).message.split('\n')[0]}` }
    }
    return auditExport(join(tree, change.appPrefix))
  }
  try {
    const [base, head] = [await auditSide('base'), await auditSide('head')]
    if ('unavailable' in head) return unavailable(`the head was not audited: ${head.unavailable}`)
    if ('unavailable' in base) return unavailable(`the base was not audited: ${base.unavailable}`)
    return { base: base.report, head: head.report }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
