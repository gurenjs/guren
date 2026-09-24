/**
 * Files touched and lines changed per step (RFC 0030 §7, Part 3), the numbers the step width of
 * §5 (Open Question 3) is retuned from. Measured from the commit HEAD named when `plan:next` first
 * marked the step to the working tree, untracked files included, so work over several commits
 * and work not yet committed both count. A measurement, never a gate: nothing refuses on it, and
 * what cannot be measured is recorded with its reason, never as a zero.
 */

import { constants } from 'node:fs'
import { open, realpath, stat, type FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { runGit, runGitRaw } from '../changed-files'
import { planBesideExclusions } from './beside'
import type { PlanActiveStep, PlanStepRecord, PlanStepWork, PlanStepWorkFile } from './state'

type Unsettled<T> = T extends unknown ? Omit<T, 'settled'> : never
export type PlanStepWorkReading = Unsettled<PlanStepWork>

/** Written by tools, not by the step: `.guren/` holds codegen output and the plan state, the rest are lockfiles. */
const WORK_EXCLUSIONS = [':(exclude).guren', ...['bun.lock', 'bun.lockb', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'].map((name) => `:(exclude,glob)**/${name}`)]

/** drizzle-kit's snapshots: `<out>/<migration>/snapshot.json` beside a `migration.sql`, and the older `meta/` layout. */
const LEGACY_DRIZZLE_META = /(?:^|\/)meta\/(?:_journal|\d+_snapshot)\.json$/u
const DRIZZLE_SNAPSHOT = /(?:^|\/)snapshot\.json$/u

/** git's own test for a binary file: a NUL byte in the first 8000 bytes. */
const BINARY_PROBE_BYTES = 8000
const COUNT_CHUNK_BYTES = 65536

function unmeasured(reason: string): Extract<PlanStepWorkReading, { measured: false }> {
  return { measured: false, reason }
}

/** The commit HEAD names, or `undefined` outside a repository, before the first commit, or without git. */
export async function readStepStart(root: string): Promise<string | undefined> {
  return (await runGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD']))?.[0]
}

async function isDrizzleSnapshot(realRoot: string, path: string): Promise<boolean> {
  if (LEGACY_DRIZZLE_META.test(path)) return true
  if (!DRIZZLE_SNAPSHOT.test(path)) return false
  return stat(join(realRoot, dirname(path), 'migration.sql')).then(
    (found) => found.isFile(),
    () => false,
  )
}

/**
 * Lines as `git diff --numstat` counts them for an added file: a symlink is one line (its target),
 * and `null` is a binary file or one that is neither a file nor a symlink, or could not be read.
 * Binary is the NUL probe alone; a tracked file gets git's own decision, which reads attributes.
 * One open resolves the path, so nothing can swap it between the check and the read; `O_NONBLOCK`
 * keeps a FIFO from blocking the open, and has no effect on a regular file.
 */
async function untrackedLines(file: string): Promise<number | null> {
  let handle: FileHandle
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ELOOP' ? 1 : null
  }
  try {
    if (!(await handle.stat()).isFile()) return null
    const probe = Buffer.alloc(BINARY_PROBE_BYTES)
    let probed = 0
    while (probed < BINARY_PROBE_BYTES) {
      const { bytesRead } = await handle.read(probe, probed, BINARY_PROBE_BYTES - probed, probed)
      if (bytesRead === 0) break
      probed += bytesRead
    }
    if (probe.subarray(0, probed).includes(0)) return null
    // Positional reads, not a stream over the handle: on Bun 1.3.14 a drained `createReadStream`
    // keeps the descriptor open past `handle.close()`.
    const chunk = Buffer.alloc(COUNT_CHUNK_BYTES)
    let lines = 0
    let last: number | undefined
    let position = 0
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, COUNT_CHUNK_BYTES, position)
      if (bytesRead === 0) break
      for (let index = 0; index < bytesRead; index += 1) if (chunk[index] === 0x0a) lines += 1
      last = chunk[bytesRead - 1]
      position += bytesRead
    }
    return last === undefined || last === 0x0a ? lines : lines + 1
  } catch {
    return null
  } finally {
    // A measurement never fails a run, a close that throws included.
    await handle.close().catch(() => undefined)
  }
}

function numstatCount(text: string | undefined): number | null {
  return text === undefined || text === '-' ? null : Number(text)
}

/** `-z` output split on NUL, the trailing terminator dropped; nothing is trimmed, so a path keeps its spaces. */
function nulSeparated(output: string): string[] {
  const fields = output.split('\0')
  if (fields[fields.length - 1] === '') fields.pop()
  return fields
}

/**
 * The step's work from `from` to the working tree under `root`, leaving out what tools write
 * (`.guren/`, lockfiles, drizzle-kit snapshots) and the plan's own records; a migration's SQL
 * counts. A rename counts as a removed file and an added one (`--no-renames`).
 */
export async function measureStepWork(root: string, planPath: string, from: string): Promise<PlanStepWorkReading> {
  const short = from.slice(0, 12)
  let realRoot: string
  let realPlan: string
  try {
    ;[realRoot, realPlan] = await Promise.all([realpath(root), realpath(planPath)])
  } catch (error) {
    return unmeasured(`the application or the plan could not be resolved: ${error instanceof Error ? error.message : String(error)}`)
  }
  if ((await runGit(realRoot, ['cat-file', '-e', `${from}^{commit}`])) === null) {
    return unmeasured(`the commit the step started from (${short}) is not in this repository, or git could not be run`)
  }
  if ((await runGit(realRoot, ['merge-base', '--is-ancestor', from, 'HEAD'])) === null) {
    return unmeasured(`the commit the step started from (${short}) is no longer an ancestor of HEAD, so a diff would count work that is not the step's`)
  }
  const pathspecs = ['--', '.', ...WORK_EXCLUSIONS, ...planBesideExclusions(realRoot, realPlan, { records: true })]
  const [diff, untracked] = await Promise.all([
    runGitRaw(realRoot, ['diff', '--numstat', '-z', '--no-renames', '--relative', from, ...pathspecs]),
    runGitRaw(realRoot, ['ls-files', '-z', '--others', '--exclude-standard', ...pathspecs]),
  ])
  if (diff === null || untracked === null) return unmeasured(`git could not diff the working tree against ${short}`)

  const files: PlanStepWorkFile[] = []
  // Without renames, each `-z` numstat entry is `added\tremoved\tpath`, the path unquoted.
  for (const entry of nulSeparated(diff)) {
    const [added, removed] = entry.split('\t', 2)
    const path = entry.slice(`${added}\t${removed}\t`.length)
    if (!(await isDrizzleSnapshot(realRoot, path))) files.push({ path, added: numstatCount(added), removed: numstatCount(removed) })
  }
  for (const path of nulSeparated(untracked)) {
    if (await isDrizzleSnapshot(realRoot, path)) continue
    const added = await untrackedLines(join(realRoot, path))
    files.push({ path, added, removed: added === null ? null : 0 })
  }

  files.sort((a, b) => a.path.localeCompare(b.path))
  const sum = (key: 'added' | 'removed'): number => files.reduce((total, file) => total + (file[key] ?? 0), 0)
  return { measured: true, from, files, added: sum('added'), removed: sum('removed') }
}

export interface StepWorkInput {
  stepId: string
  /** The plan file relative to the application root, POSIX separators: what the mark names. */
  planFile: string
  active: PlanActiveStep | undefined
  /** The step's record before this run. */
  previous: PlanStepRecord | undefined
  outcome: PlanStepRecord['outcome']
  measure: (from: string) => Promise<PlanStepWorkReading>
}

/**
 * The work a record carries. It is measured while the step is the marked one and has not yet
 * verified; once a run verified it, every later record carries that measurement, so a re-check
 * under a fresh mark (a drifted step, the Stop hook, `--step` again) never replaces it with the
 * re-check's own diff. A record verified before the field existed counts as settled unmeasured.
 */
export async function stepWork(input: StepWorkInput): Promise<PlanStepWork> {
  const { previous, active } = input
  if (previous?.work?.settled) return previous.work
  if (previous && !previous.work && previous.outcome === 'verified') {
    return { ...unmeasured('the step verified before files touched and lines changed were recorded'), settled: true }
  }
  const settled = input.outcome === 'verified'
  if (active?.step !== input.stepId || active.plan !== input.planFile) {
    return { ...(previous?.work ?? unmeasured('plan:next did not mark this step, so where its work started is not known')), settled }
  }
  if (active.from === undefined) return { ...unmeasured('plan:next marked this step before it recorded where work starts'), settled }
  if (active.from === null) return { ...unmeasured('git could not read HEAD when plan:next marked the step'), settled }
  return { ...(await input.measure(active.from)), settled }
}
