/**
 * The `dependency-advisory` fact of RFC 0040 §3: `bun audit` run on each side's lockfile, both
 * against the advisory database as it is now, so an advisory the change's dependencies brought in
 * is told apart from one published since the base. `bun audit` reads the lockfile and the
 * manifests and asks the registry; nothing is installed and no application code runs.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { promisify } from 'node:util'

import type { AuditFinding } from '../audit'
import { dependencyFindingsFromOutput, startDependencyScan } from '../audit-deps'
import type { ChangeSide, ResolvedChange } from './resolve'
import { exportBlobs } from './revision-audit'

const execute = promisify(execFile)

const LOCKFILE = 'bun.lock'
// What `bun audit` reads besides the lockfile: every manifest, and the registry it is told to ask.
const AUDIT_INPUTS = new Set(['package.json', 'bunfig.toml', '.npmrc'])

/** The advisory keys (`deps:<package>:<GHSA>`) of each side, or why they could not be read. */
export type ChangeAdvisories = { base: string[]; head: string[] } | { unavailable: string }

const git = (cwd: string, args: string[]): Promise<string | undefined> =>
  execute('git', args, { cwd }).then((result) => result.stdout.replace(/\n$/, ''), () => undefined)

/** The directory, from the repository root, of the `bun.lock` nearest the application at the head. */
async function lockfileDirectory(root: string, change: ResolvedChange): Promise<string | undefined> {
  const segments = change.appPrefix.split('/').filter((segment) => segment.length > 0)
  for (let depth = segments.length; depth >= 0; depth--) {
    const directory = segments.slice(0, depth).map((segment) => `${segment}/`).join('')
    if ((await git(root, ['cat-file', '-e', `${change.head}:${directory}${LOCKFILE}`])) !== undefined) return directory
  }
  return undefined
}

async function sideAdvisories(root: string, rev: string, directory: string, scratch: string, side: ChangeSide): Promise<string[] | { unavailable: string }> {
  if ((await git(root, ['cat-file', '-e', `${rev}:${directory}${LOCKFILE}`])) === undefined) return []
  const tree = join(scratch, side)
  const refused = await exportBlobs(root, rev, tree, '', (path) => path === `${directory}${LOCKFILE}` || AUDIT_INPUTS.has(posix.basename(path)))
  if (refused) return { unavailable: `the ${side}'s lockfile could not be exported: ${refused}` }
  const findings: AuditFinding[] = []
  const scan = dependencyFindingsFromOutput(await startDependencyScan(join(tree, directory)), findings)
  if (scan.status !== 'complete') return { unavailable: findings.find((finding) => finding.key === 'deps:scan')?.message ?? `the ${side}'s dependencies could not be scanned` }
  return findings.map((finding) => finding.key).filter((key) => key.startsWith('deps:') && key !== 'deps:none').sort()
}

export async function changeAdvisories(cwd: string, change: ResolvedChange): Promise<ChangeAdvisories> {
  const root = await git(cwd, ['rev-parse', '--show-toplevel'])
  if (root === undefined) return { unavailable: 'git could not name the repository root' }
  const directory = await lockfileDirectory(root, change)
  if (directory === undefined) return { unavailable: `no ${LOCKFILE} at the head, which \`bun audit\` reads (a binary bun.lockb is not read)` }
  const scratch = await mkdtemp(join(tmpdir(), 'guren-change-advisories-'))
  try {
    const [base, head] = [await sideAdvisories(root, change.mergeBase, directory, scratch, 'base'), await sideAdvisories(root, change.head, directory, scratch, 'head')]
    if (!Array.isArray(head)) return head
    if (!Array.isArray(base)) return base
    return { base, head }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
