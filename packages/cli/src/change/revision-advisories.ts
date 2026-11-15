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
// The registry `bun audit` asks: the base's, so the change cannot choose the one it is judged against.
// Not `bunfig.toml`: its `[install] production` would leave dev dependencies out of the scan.
const REGISTRY_CONFIG = new Set(['.npmrc'])
// Each of these overrides the registry `.npmrc` names, and the CLI may have loaded them from the head's `.env`.
const REGISTRY_ENV = /^(?:npm_config_|bun_config_)/iu
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']

/** A changed dependency file: as the lane names it, and from the repository root on each side. */
export interface ChangedDependencyFile {
  file: string
  fromRoot: string
  /** Where the file was at the base, when the change renamed it. */
  baseFromRoot?: string
}

/** One lockfile's advisory keys (`deps:<package>:<GHSA>`) on each side, or why they could not be read. */
export type LockfileAdvisories = { directory: string; files: string[] } & ({ base: string[]; head: string[] } | { unavailable: string })

export interface ChangeAdvisoryOptions {
  /** `bun audit --json` in a directory; the default runs it with no registry override from the environment. */
  scan?: (directory: string) => Promise<DependencyScanOutput | null>
}

const git = (cwd: string, args: string[]): Promise<string | undefined> =>
  execute('git', args, { cwd }).then((result) => result.stdout.replace(/\n$/, ''), () => undefined)

const exists = async (root: string, rev: string, path: string): Promise<boolean> => (await git(root, ['cat-file', '-e', `${rev}:${path}`])) !== undefined

const ancestors = (fromRoot: string): string[] => {
  const segments = posix.dirname(fromRoot).split('/').filter((segment) => segment !== '' && segment !== '.')
  return segments.map((_, index) => `${segments.slice(0, segments.length - index).join('/')}/`).concat('')
}

type Governing = { directory: string; binary: boolean } | undefined

/** The nearest directory holding a lockfile of either kind at `rev`. */
async function governingLockfile(root: string, rev: string, fromRoot: string): Promise<Governing> {
  for (const directory of ancestors(fromRoot)) {
    if (await exists(root, rev, `${directory}${LOCKFILE}`)) return { directory, binary: false }
    if (await exists(root, rev, `${directory}${BINARY_LOCKFILE}`)) return { directory, binary: true }
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

function defaultScan(directory: string): Promise<DependencyScanOutput | null> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !REGISTRY_ENV.test(key))) as Record<string, string>
  return startDependencyScan(directory, env)
}

const manifestOf = (path: string): string => `${posix.dirname(path) === '.' ? '' : `${posix.dirname(path)}/`}package.json`

async function sideKeys(
  root: string, rev: string, side: ChangeSide, governing: Governing, manifests: readonly string[], registryRev: string, scratch: string,
  scan: NonNullable<ChangeAdvisoryOptions['scan']>,
): Promise<string[] | { unavailable: string }> {
  if (!governing) {
    // No lockfile and no dependencies is a side with no advisories; dependencies without one say nothing.
    for (const manifest of manifests) {
      if (declaresDependencies(await git(root, ['show', `${rev}:${manifest}`]))) return { unavailable: `the ${side} declares dependencies in ${manifest} and no ${LOCKFILE} governs it` }
    }
    return side === 'base' ? [] : { unavailable: `no ${LOCKFILE} governs the changed files at the head` }
  }
  const { directory } = governing
  if (governing.binary) return { unavailable: `the ${side}'s ${directory}${BINARY_LOCKFILE} is binary, which \`bun audit\` does not read` }
  const tree = join(scratch, side)
  const lockfile = `${directory}${LOCKFILE}`
  const refused = await exportBlobs(root, rev, tree, '', (path) => path === lockfile || posix.basename(path) === 'package.json')
    ?? await exportBlobs(root, registryRev, tree, '', (path) => REGISTRY_CONFIG.has(posix.basename(path)))
  if (refused) return { unavailable: `the ${side}'s lockfile could not be exported: ${refused}` }
  const output = await scan(join(tree, directory))
  const findings: AuditFinding[] = []
  const result = dependencyFindingsFromOutput(output, findings)
  if (result.status !== 'complete') return { unavailable: findings.find((finding) => finding.key === 'deps:scan')?.message ?? `the ${side}'s dependencies could not be scanned` }
  // `bun audit` warns on stderr, exit 0, when it skips a registry it could not ask: a report without that registry's packages.
  const warning = output?.stderr.trim()
  if (warning) return { unavailable: `\`bun audit\` warned on the ${side}, so its report may leave packages out: ${warning.split('\n')[0]}` }
  return findings.map((finding) => finding.key).filter((key) => key.startsWith('deps:') && key !== 'deps:none').sort()
}

/** One entry per pair of lockfiles (the head's and the base's) governing changed dependency files. */
export async function changeAdvisories(cwd: string, change: ResolvedChange, changed: readonly ChangedDependencyFile[], options: ChangeAdvisoryOptions = {}): Promise<LockfileAdvisories[]> {
  const scan = options.scan ?? defaultScan
  const root = await git(cwd, ['rev-parse', '--show-toplevel'])
  if (root === undefined) return [{ directory: '', files: changed.map((entry) => entry.file), unavailable: 'git could not name the repository root' }]
  const groups = new Map<string, { head: Governing; base: Governing; files: ChangedDependencyFile[] }>()
  for (const entry of changed) {
    const head = await governingLockfile(root, change.head, entry.fromRoot)
    // Read on each side: a package can move from a workspace's lockfile to its own, or be renamed.
    const base = await governingLockfile(root, change.mergeBase, entry.baseFromRoot ?? entry.fromRoot)
    const key = `${head?.directory ?? '-'}\0${base?.directory ?? '-'}`
    const group = groups.get(key) ?? { head, base, files: [] }
    group.files.push(entry)
    groups.set(key, group)
  }
  const results: LockfileAdvisories[] = []
  for (const group of groups.values()) {
    const files = group.files.map((entry) => entry.file)
    const directory = group.head?.directory ?? group.base?.directory ?? ''
    const headLockfile = group.head && !group.head.binary ? `${group.head.directory}${LOCKFILE}` : undefined
    if (headLockfile && !group.files.some((entry) => entry.fromRoot === headLockfile)) {
      results.push({ directory, files, unavailable: `a manifest changed its dependencies and ${headLockfile} did not` })
      continue
    }
    const scratch = await mkdtemp(join(tmpdir(), 'guren-change-advisories-'))
    try {
      const base = await sideKeys(root, change.mergeBase, 'base', group.base, group.files.map((entry) => manifestOf(entry.baseFromRoot ?? entry.fromRoot)), change.mergeBase, scratch, scan)
      const head = await sideKeys(root, change.head, 'head', group.head, group.files.map((entry) => manifestOf(entry.fromRoot)), change.mergeBase, scratch, scan)
      if (!Array.isArray(head)) results.push({ directory, files, ...head })
      else if (!Array.isArray(base)) results.push({ directory, files, ...base })
      else results.push({ directory, files, base, head })
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }
  return results
}
