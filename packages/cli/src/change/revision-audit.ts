/**
 * The audit of each side of a change (RFC 0040 §3): a revision is exported from git objects into
 * a temp directory, given the install that is on disk when its lockfile is that install's, and
 * audited by this CLI in a child. It runs the application's code, as `guren audit` does.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import type { AuditReport } from '../audit'
import { cliEntry } from '../cli-entry'
import type { ChangeReader, ChangeSide, ResolvedChange } from './resolve'

const execute = promisify(execFile)

const LOCKFILES = ['bun.lock', 'bun.lockb']
const CODEGEN_TIMEOUT_MS = 60_000
const AUDIT_TIMEOUT_MS = 120_000
const OUTPUT_LIMIT = 64 * 1024 * 1024

/** One side's audit, or why it could not be taken. */
export type RevisionAudit = { report: AuditReport } | { unavailable: string }

export interface ChangeAudits {
  base: RevisionAudit
  head: RevisionAudit
}

/** The repository root, then each directory down to the application root, each with its trailing slash. */
function installDirectories(appPrefix: string): string[] {
  const segments = appPrefix.split('/').filter((segment) => segment.length > 0)
  return ['', ...segments.map((_, index) => `${segments.slice(0, index + 1).join('/')}/`)]
}

async function onDisk(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch(() => null)
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
  const unavailable = (reason: string): ChangeAudits => ({ base: { unavailable: reason }, head: { unavailable: reason } })
  const root = await execute('git', ['rev-parse', '--show-toplevel'], { cwd }).then((result) => result.stdout.replace(/\n$/, ''), () => undefined)
  if (root === undefined) return unavailable('git could not name the repository root')
  const directories = installDirectories(change.appPrefix)
  const installs = directories.filter((directory) => existsSync(join(root, directory, 'node_modules')))
  if (installs.length === 0) return unavailable('no node_modules is installed here; run bun install')

  const scratch = await mkdtemp(join(tmpdir(), 'guren-change-audit-'))
  const auditSide = async (side: ChangeSide): Promise<RevisionAudit> => {
    const rev = side === 'base' ? change.mergeBase : change.head
    for (const directory of directories) {
      for (const lockfile of LOCKFILES) {
        const path = `${directory}${lockfile}`
        if ((await reader.readOutside(side, path)) !== (await onDisk(join(root, path)))) return { unavailable: `${path} at ${rev.slice(0, 12)} is not the lockfile installed here` }
      }
    }
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
    return { base: await auditSide('base'), head: await auditSide('head') }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
