/**
 * The `dependency-advisory` fact of RFC 0040 §3: `bun audit` run on the lockfile governing each
 * changed dependency file, on both sides and against the advisory database as it is now, so an
 * advisory the change's dependencies brought in is told apart from one published since the base.
 * `bun audit` reads the lockfile and the manifests and asks the registry; nothing is installed.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { promisify } from 'node:util'

import type { AuditFinding } from '../audit'
import { dependencyFindingsFromOutput, startDependencyScan, type DependencyScanOutput } from '../audit-deps'
import type { ChangeSide, ResolvedChange } from './resolve'
import { exportBlobs } from './revision-audit'

const execute = promisify(execFile)

const LOCKFILE = 'bun.lock'
const BINARY_LOCKFILE = 'bun.lockb'
// The registry `bun audit` asks: always the base's, so the change cannot choose the one it is judged against.
const REGISTRY_CONFIG = new Set(['bunfig.toml', '.npmrc'])
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']

/** A changed dependency file: as the lane names it, and from the repository root. */
export interface ChangedDependencyFile {
  file: string
  fromRoot: string
}

/** One lockfile's advisory keys (`deps:<package>:<GHSA>`) on each side, or why they could not be read. */
export type LockfileAdvisories = { directory: string; files: string[] } & ({ base: string[]; head: string[] } | { unavailable: string })

export interface ChangeAdvisoryOptions {
  /** `bun audit --json` in a directory; the default runs it. */
  scan?: (directory: string) => Promise<DependencyScanOutput | null>
}

const git = (cwd: string, args: string[]): Promise<string | undefined> =>
  execute('git', args, { cwd }).then((result) => result.stdout.replace(/\n$/, ''), () => undefined)

const exists = async (root: string, rev: string, path: string): Promise<boolean> => (await git(root, ['cat-file', '-e', `${rev}:${path}`])) !== undefined

const ancestors = (fromRoot: string): string[] => {
  const segments = posix.dirname(fromRoot).split('/').filter((segment) => segment !== '' && segment !== '.')
  return segments.map((_, index) => `${segments.slice(0, segments.length - index).join('/')}/`).concat('')
}

/** The nearest directory holding a lockfile of either kind, on the head or, where the change deleted it, the base. */
async function governingLockfile(root: string, change: ResolvedChange, fromRoot: string): Promise<{ directory: string; binary: boolean } | undefined> {
  for (const directory of ancestors(fromRoot)) {
    for (const rev of [change.head, change.mergeBase]) {
      if (await exists(root, rev, `${directory}${LOCKFILE}`)) return { directory, binary: false }
      if (await exists(root, rev, `${directory}${BINARY_LOCKFILE}`)) return { directory, binary: true }
    }
  }
  return undefined
}

function declaresDependencies(manifest: string | undefined): boolean {
  if (manifest === undefined) return false
  try {
    const value = JSON.parse(manifest) as Record<string, unknown>
    // A workspace root may declare none itself while its members do.
    if (value.workspaces !== undefined) return true
    return DEPENDENCY_FIELDS.some((field) => typeof value[field] === 'object' && value[field] !== null && Object.keys(value[field] as object).length > 0)
  } catch {
    return true
  }
}

async function sideKeys(root: string, change: ResolvedChange, side: ChangeSide, directory: string, scratch: string, scan: NonNullable<ChangeAdvisoryOptions['scan']>): Promise<string[] | { unavailable: string }> {
  const rev = side === 'base' ? change.mergeBase : change.head
  if (!(await exists(root, rev, `${directory}${LOCKFILE}`))) {
    if (await exists(root, rev, `${directory}${BINARY_LOCKFILE}`)) return { unavailable: `the ${side} has a binary ${BINARY_LOCKFILE}, which \`bun audit\` does not read` }
    // No lockfile and no dependencies is a side with no advisories; dependencies without one say nothing.
    if (declaresDependencies(await git(root, ['show', `${rev}:${directory}package.json`]))) return { unavailable: `the ${side} declares dependencies in ${directory}package.json and has no ${LOCKFILE}` }
    return []
  }
  const tree = join(scratch, side)
  const lockfile = `${directory}${LOCKFILE}`
  const refused = await exportBlobs(root, rev, tree, '', (path) => path === lockfile || posix.basename(path) === 'package.json')
    ?? await exportBlobs(root, change.mergeBase, tree, '', (path) => REGISTRY_CONFIG.has(posix.basename(path)))
  if (refused) return { unavailable: `the ${side}'s lockfile could not be exported: ${refused}` }
  const findings: AuditFinding[] = []
  const result = dependencyFindingsFromOutput(await scan(join(tree, directory)), findings)
  if (result.status !== 'complete') return { unavailable: findings.find((finding) => finding.key === 'deps:scan')?.message ?? `the ${side}'s dependencies could not be scanned` }
  return findings.map((finding) => finding.key).filter((key) => key.startsWith('deps:') && key !== 'deps:none').sort()
}

/** One entry per lockfile a changed dependency file is governed by, each with the files it governs. */
export async function changeAdvisories(cwd: string, change: ResolvedChange, changed: readonly ChangedDependencyFile[], options: ChangeAdvisoryOptions = {}): Promise<LockfileAdvisories[]> {
  const scan = options.scan ?? startDependencyScan
  const root = await git(cwd, ['rev-parse', '--show-toplevel'])
  if (root === undefined) return [{ directory: '', files: changed.map((entry) => entry.file), unavailable: 'git could not name the repository root' }]
  const groups = new Map<string, { binary: boolean; files: ChangedDependencyFile[] }>()
  const results: LockfileAdvisories[] = []
  for (const entry of changed) {
    const lockfile = await governingLockfile(root, change, entry.fromRoot)
    if (!lockfile) {
      results.push({ directory: posix.dirname(entry.fromRoot), files: [entry.file], unavailable: `no ${LOCKFILE} governs ${entry.fromRoot}` })
      continue
    }
    const group = groups.get(lockfile.directory) ?? { binary: lockfile.binary, files: [] }
    group.files.push(entry)
    groups.set(lockfile.directory, group)
  }
  for (const [directory, group] of groups) {
    const files = group.files.map((entry) => entry.file)
    if (group.binary) {
      results.push({ directory, files, unavailable: `${directory}${BINARY_LOCKFILE} is binary, which \`bun audit\` does not read` })
      continue
    }
    if (!group.files.some((entry) => posix.basename(entry.fromRoot) === LOCKFILE)) {
      results.push({ directory, files, unavailable: `a manifest changed its dependencies and ${directory}${LOCKFILE} did not` })
      continue
    }
    const scratch = await mkdtemp(join(tmpdir(), 'guren-change-advisories-'))
    try {
      const [base, head] = [await sideKeys(root, change, 'base', directory, scratch, scan), await sideKeys(root, change, 'head', directory, scratch, scan)]
      if (!Array.isArray(head)) results.push({ directory, files, ...head })
      else if (!Array.isArray(base)) results.push({ directory, files, ...base })
      else results.push({ directory, files, base, head })
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }
  return results
}
