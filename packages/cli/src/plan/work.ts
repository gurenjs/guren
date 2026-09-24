/**
 * Files touched and lines changed per step (RFC 0030 §7, Part 3), the numbers the step width of
 * §5 (Open Question 3) is retuned from. Measured from the commit HEAD named when `plan:next` first
 * marked the step to the working tree, untracked files included, so work over several commits
 * and work not yet committed both count. A measurement, never a gate: nothing refuses on it, and
 * what cannot be measured is recorded with its reason, never as a zero.
 */

import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { runGit } from '../changed-files'
import { planBesideExclusions } from './beside'
import type { PlanActiveStep, PlanStepRecord, PlanStepWork } from './state'

type Unsettled<T> = T extends unknown ? Omit<T, 'settled'> : never
export type PlanStepWorkReading = Unsettled<PlanStepWork>

/** Written by tools, not by the step: `.guren/` holds codegen output and the plan state, the rest are lockfiles. */
const WORK_EXCLUSIONS = [':(exclude).guren', ...['bun.lock', 'bun.lockb', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'].map((name) => `:(exclude,glob)**/${name}`)]

/** drizzle-kit's snapshots: `<out>/<migration>/snapshot.json` beside a `migration.sql`, and the older `meta/` layout. */
const LEGACY_DRIZZLE_META = /(?:^|\/)meta\/(?:_journal|\d+_snapshot)\.json$/u
const DRIZZLE_SNAPSHOT = /(?:^|\/)snapshot\.json$/u

/** git's own test for a binary file: a NUL byte in the first 8000 bytes. */
const BINARY_PROBE_BYTES = 8000

function unmeasured(reason: string): PlanStepWorkReading {
  return { measured: false, reason }
}

/** The commit HEAD names, or `undefined` outside a repository, before the first commit, or without git. */
export async function readStepStart(root: string): Promise<string | undefined> {
  const realRoot = await realpath(root).catch(() => root)
  return (await runGit(realRoot, ['rev-parse', '--verify', '--quiet', 'HEAD']))?.[0]
}

async function isDrizzleSnapshot(realRoot: string, path: string): Promise<boolean> {
  if (LEGACY_DRIZZLE_META.test(path)) return true
  if (!DRIZZLE_SNAPSHOT.test(path)) return false
  return stat(join(realRoot, dirname(path), 'migration.sql')).then(
    (found) => found.isFile(),
    () => false,
  )
}

/** Lines as `git diff --numstat` counts them for an added file; `null` for a binary or unreadable one. */
async function untrackedLines(file: string): Promise<number | null> {
  const bytes = await readFile(file).catch(() => undefined)
  if (bytes === undefined || bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) return null
  if (bytes.length === 0) return 0
  let lines = 0
  for (const byte of bytes) if (byte === 0x0a) lines += 1
  return bytes[bytes.length - 1] === 0x0a ? lines : lines + 1
}

function numstatCount(text: string | undefined): number | null {
  return text === undefined || text === '-' ? null : Number(text)
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
    runGit(realRoot, ['-c', 'core.quotePath=false', 'diff', '--numstat', '--no-renames', '--relative', from, ...pathspecs]),
    runGit(realRoot, ['-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard', ...pathspecs]),
  ])
  if (diff === null || untracked === null) return unmeasured(`git could not diff the working tree against ${short}`)

  const files: Array<{ path: string; added: number | null; removed: number | null }> = []
  for (const line of diff) {
    const [added, removed, ...rest] = line.split('\t')
    files.push({ path: rest.join('\t'), added: numstatCount(added), removed: numstatCount(removed) })
  }
  for (const path of untracked) {
    const added = await untrackedLines(join(realRoot, path))
    files.push({ path, added, removed: added === null ? null : 0 })
  }

  const kept: typeof files = []
  for (const file of files) if (!(await isDrizzleSnapshot(realRoot, file.path))) kept.push(file)
  kept.sort((a, b) => a.path.localeCompare(b.path))
  const sum = (key: 'added' | 'removed'): number => kept.reduce((total, file) => total + (file[key] ?? 0), 0)
  return { measured: true, from, files: kept, added: sum('added'), removed: sum('removed') }
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
  const settledBefore = previous?.work ? previous.work.settled : previous?.outcome === 'verified'
  if (settledBefore) return previous?.work ?? { measured: false, reason: 'the step verified before files touched and lines changed were recorded', settled: true }
  const settled = input.outcome === 'verified'
  if (active?.step !== input.stepId || active.plan !== input.planFile) {
    return { ...(previous?.work ?? unmeasured('plan:next did not mark this step, so where its work started is not known')), settled }
  }
  if (active.from === undefined) return { measured: false, reason: 'git could not read HEAD when plan:next marked the step', settled }
  return { ...(await input.measure(active.from)), settled }
}
