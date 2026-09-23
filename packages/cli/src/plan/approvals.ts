/**
 * A plan's approvals (RFC 0030 §4, §9): `{ hash, approvedAt, approvedBy }` beside the plan,
 * never inside it, since approval metadata is outside the hash it names. Committed, like the
 * decision log: who approved is also who the repository's history says committed it.
 */

import { createHash } from 'node:crypto'

import { z } from 'zod'

import { CliError } from '../cli-error'
import { planSiblingPath, readBesideRecord, writeFileAtomic, type BesideRecordRead } from './beside'
import { canonicalJson, planHash } from './identity'
import { hasBaseline } from './render'
import { listPlanElementEntries, type Plan, type PlanDraft } from './schema'
import type { PlanPropertyReading } from './status'

const PLAN_APPROVALS_VERSION = 1

const PlanPropertyReadingSchema = z.object({
  element: z.string(),
  label: z.string(),
  property: z.string(),
  planned: z.string().optional(),
  verdict: z.enum(['match', 'differ', 'unknown']),
}) satisfies z.ZodType<PlanPropertyReading>

const PlanApprovalSchema = z.object({
  /** `planHash()` of the approved plan, baseline included. */
  hash: z.string(),
  approvedAt: z.string(),
  /** Whoever `git config` named, where it answered. */
  approvedBy: z.string().optional(),
  /**
   * How each planned property of the plan's `alter`s read before its work (RFC 0030 §6): the
   * earliest reading under the same baseline, else the one taken at this approval. Outside the
   * hash, so a re-approval can add the ones missing; it never replaces one.
   */
  readings: z.object({ baseline: z.string(), properties: z.array(PlanPropertyReadingSchema) }).optional(),
})

const PlanApprovalsSchema = z.object({
  approvalsVersion: z.literal(PLAN_APPROVALS_VERSION),
  approvals: z.array(PlanApprovalSchema),
})

export type PlanApproval = z.infer<typeof PlanApprovalSchema>
export type PlanApprovals = z.infer<typeof PlanApprovalsSchema>

export function planApprovalsPath(planPath: string): string {
  return planSiblingPath(planPath, 'approvals')
}

export function readPlanApprovals(planPath: string): Promise<BesideRecordRead<PlanApprovals>> {
  return readBesideRecord(planApprovalsPath(planPath), PlanApprovalsSchema, 'approvals')
}

/**
 * The approvals `read` found, or an empty record where there is no file. A file that would not
 * read is refused rather than replaced: it is a committed record nobody can rebuild.
 */
export function requireReadableApprovals(read: BesideRecordRead<PlanApprovals>): PlanApprovals {
  if (read.unreadable) {
    throw new CliError(`${read.unreadable}\nThe approvals file is a committed record, so this command will not replace it. Fix the file, then run this again.`)
  }
  return read.value ?? { approvalsVersion: PLAN_APPROVALS_VERSION, approvals: [] }
}

/** The approval given at `hash`, if any. */
export function approvalAt(approvals: PlanApprovals, hash: string): PlanApproval | undefined {
  return approvals.approvals.find((candidate) => candidate.hash === hash)
}

/**
 * Appends in the order approvals were given. A hash already approved keeps its entry, and gains
 * only the readings `approval` carries that it lacks; nothing is written when it lacks none.
 */
export async function recordPlanApproval(
  planPath: string,
  approvals: PlanApprovals,
  approval: PlanApproval,
): Promise<{ existing?: PlanApproval; readingsAdded: PlanPropertyReading[] }> {
  const path = planApprovalsPath(planPath)
  const write = (entries: PlanApproval[]) => writeFileAtomic(path, `${JSON.stringify({ ...approvals, approvals: entries }, null, 2)}\n`)
  const existing = approvalAt(approvals, approval.hash)
  if (!existing) {
    await write([...approvals.approvals, approval])
    return { readingsAdded: approval.readings?.properties ?? [] }
  }
  const held = existing.readings?.properties ?? []
  const added = (approval.readings?.properties ?? []).filter((reading) => !held.some((entry) => sameReading(entry, reading)))
  if (!approval.readings || added.length === 0) return { existing, readingsAdded: [] }
  const updated: PlanApproval = { ...existing, readings: { baseline: approval.readings.baseline, properties: [...held, ...added] } }
  await write(approvals.approvals.map((entry) => (entry === existing ? updated : entry)))
  return { existing: updated, readingsAdded: added }
}

/** Names the baseline a reading was taken under: readings carry over only within one, since another is another plan's start. */
export function baselineDigest(plan: Plan): string {
  return createHash('sha256').update(canonicalJson(plan.baseline), 'utf8').digest('hex')
}

/** One reading per element, name in code, property and planned value; the earliest is the one that counts. */
export function sameReading(a: PlanPropertyReading, b: PlanPropertyReading): boolean {
  return a.element === b.element && a.label === b.label && a.property === b.property && a.planned === b.planned
}

/**
 * The readings an approval of `plan` records: every reading the approvals already hold under the
 * plan's baseline, earliest first, then each of `current` (how the application reads now) they
 * lack. A reading taken late can only miss a change, never credit one: a property that already
 * matched is never counted, and one that did not has moved since.
 */
export function approvalReadings(approvals: PlanApprovals, plan: Plan, current: readonly PlanPropertyReading[]): NonNullable<PlanApproval['readings']> {
  const baseline = baselineDigest(plan)
  const earlier = approvals.approvals.flatMap((entry) => (entry.readings?.baseline === baseline ? entry.readings.properties : []))
  const properties: PlanPropertyReading[] = []
  for (const reading of [...earlier, ...current]) {
    if (!properties.some((held) => sameReading(held, reading))) properties.push(reading)
  }
  return { baseline, properties }
}

/** An `alter` whose readable planned properties all read `match` at approval (RFC 0030 §6), so none of them can show its change. */
export interface HeldAlter {
  element: string
  label: string
  held: string[]
  /** Read `unknown` at approval: a match on one of these still counts. */
  unread: string[]
}

/**
 * The `alter`s of `plan` that {@link HeldAlter} describes, judged on the verdicts `recorded` (the
 * approval entry's readings, which `judgePlan()` counts against) holds for the keys `current`
 * reads now. An element `current` does not read (its section unreadable at a re-approval) is
 * judged on every recorded reading of its id, so a re-approval that adds none keeps the answer.
 * An element with no readable reading, all `unknown` or none planned, is not one.
 */
export function heldAlters(plan: PlanDraft | Plan, current: readonly PlanPropertyReading[], recorded: readonly PlanPropertyReading[]): HeldAlter[] {
  const alters = listPlanElementEntries(plan).filter(({ element }) => (element as { change?: { kind?: string } }).change?.kind === 'alter')
  return alters.flatMap(({ id }): HeldAlter[] => {
    const keys = current.filter((reading) => reading.element === id)
    const readings = keys.length > 0 ? keys.flatMap((key) => recorded.find((reading) => sameReading(reading, key)) ?? []) : recorded.filter((reading) => reading.element === id)
    const held = readings.filter((reading) => reading.verdict === 'match')
    if (held.length === 0 || readings.some((reading) => reading.verdict === 'differ')) return []
    const unread = readings.filter((reading) => reading.verdict === 'unknown')
    return [{ element: id, label: held[0]!.label, held: held.map((reading) => reading.property), unread: unread.map((reading) => reading.property) }]
  })
}

/**
 * The readings the approval of the plan's current hash recorded, which `judgePlan()` counts an
 * `alter`'s matches against: none for an approval that recorded none, `undefined` without one.
 */
export function approvedReadings(standing: PlanApprovalStanding | undefined): PlanPropertyReading[] | undefined {
  return standing?.state === 'approved' ? (standing.approval.readings?.properties ?? []) : undefined
}

/** The commands that refuse a plan no approval names; `plan:status` names them rather than refusing. */
export const PLAN_APPROVAL_GATED_COMMANDS = ['plan:next', 'plan:verify', 'plan:waive', 'plan:close'] as const

/**
 * Whether an approval names the plan's current hash. `baseline-removed` is a draft with approvals
 * beside it: deleting `baseline` would otherwise turn an approved plan back into a draft no gate asks about.
 * `hash` is `planHash()` of a plan with a baseline and `null` for a draft.
 */
export type PlanApprovalStanding =
  | { state: 'approved'; hash: string; approval: PlanApproval }
  | { state: 'unapproved'; hash: string }
  | { state: 'baseline-removed'; hash: null; approvals: number }
  | { state: 'unreadable'; hash: string | null; reason: string }

export type PlanApprovedStanding = Extract<PlanApprovalStanding, { state: 'approved' }>

/** `undefined` for a draft with no approvals file, or an empty one: nobody approved anything there to guard. */
export async function readPlanApprovalStanding(planPath: string, plan: PlanDraft | Plan): Promise<PlanApprovalStanding | undefined> {
  const hash = hasBaseline(plan) ? planHash(plan) : null
  const read = await readPlanApprovals(planPath)
  if (read.unreadable) return { state: 'unreadable', hash, reason: read.unreadable }
  const approvals = read.value?.approvals ?? []
  if (hash === null) return approvals.length > 0 ? { state: 'baseline-removed', hash, approvals: approvals.length } : undefined
  const approval = read.value && approvalAt(read.value, hash)
  return approval ? { state: 'approved', hash, approval } : { state: 'unapproved', hash }
}

/** Why `standing` stops a command, with what to run; `consequence` says what the command would otherwise have done. */
export function describeUnapproved(planPath: string, standing: Exclude<PlanApprovalStanding, PlanApprovedStanding>, consequence: string): string {
  switch (standing.state) {
    case 'unreadable':
      return `${standing.reason}\nNo approval of ${planPath} can be read, so ${consequence}. Fix the approvals file, then run this again.`
    case 'baseline-removed':
      return `${planPath} has lost its baseline, but ${standing.approvals} approval(s) are recorded beside it, so ${consequence}: a plan is approved with its baseline, and without one it is no longer the plan anyone approved. Restore the baseline, keep the new draft in a file of its own, or run guren plan:approve ${planPath} to approve it again.`
    case 'unapproved':
      return `${planPath} is not approved at its current hash ${standing.hash}, so ${consequence}: it was edited after approval, or never approved, and what it says now may not be what anyone agreed to. Run guren plan:approve ${planPath} once the plan says what you mean to build.`
  }
}

/**
 * The approval naming the plan's current hash (RFC 0030 §4), or a refusal that says what to run;
 * `undefined` for a draft nobody approved, which the commands accepting drafts go on with.
 * An approvals file that will not read refuses: an approval nobody can read approves nothing.
 */
export async function requirePlanApproval(planPath: string, plan: Plan, consequence: string): Promise<PlanApprovedStanding>
export async function requirePlanApproval(planPath: string, plan: PlanDraft | Plan, consequence: string): Promise<PlanApprovedStanding | undefined>
export async function requirePlanApproval(planPath: string, plan: PlanDraft | Plan, consequence: string): Promise<PlanApprovedStanding | undefined> {
  const standing = await readPlanApprovalStanding(planPath, plan)
  if (standing === undefined || standing.state === 'approved') return standing
  throw new CliError(describeUnapproved(planPath, standing, consequence))
}
