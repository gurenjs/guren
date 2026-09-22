/**
 * A plan's approvals (RFC 0030 §4, §9): `{ hash, approvedAt, approvedBy }` beside the plan,
 * never inside it, since approval metadata is outside the hash it names. Committed, like the
 * decision log: who approved is also who the repository's history says committed it.
 */

import { z } from 'zod'

import { CliError } from '../cli-error'
import { planSiblingPath, readBesideRecord, writeFileAtomic, type BesideRecordRead } from './beside'
import { planHash } from './identity'
import type { Plan } from './schema'

const PLAN_APPROVALS_VERSION = 1

const PlanApprovalSchema = z.object({
  /** `planHash()` of the approved plan, baseline included. */
  hash: z.string(),
  approvedAt: z.string(),
  /** Whoever `git config` named, where it answered. */
  approvedBy: z.string().optional(),
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

/** Appends in the order approvals were given; a hash already approved is returned and nothing is written. */
export async function recordPlanApproval(
  planPath: string,
  approvals: PlanApprovals,
  approval: PlanApproval,
): Promise<{ written: boolean; existing?: PlanApproval }> {
  const existing = approvals.approvals.find((candidate) => candidate.hash === approval.hash)
  if (existing) return { written: false, existing }
  await writeFileAtomic(planApprovalsPath(planPath), `${JSON.stringify({ ...approvals, approvals: [...approvals.approvals, approval] }, null, 2)}\n`)
  return { written: true }
}

/** Whether an approval names a stamped plan's current hash; `plan:status` reports it, the acting commands refuse on it. */
export type PlanApprovalStanding =
  | { state: 'approved'; hash: string; approval: PlanApproval }
  | { state: 'unapproved'; hash: string }
  | { state: 'unreadable'; hash: string; reason: string }

export async function readPlanApprovalStanding(planPath: string, plan: Plan): Promise<PlanApprovalStanding> {
  const hash = planHash(plan)
  const read = await readPlanApprovals(planPath)
  if (read.unreadable) return { state: 'unreadable', hash, reason: read.unreadable }
  const approval = read.value?.approvals.find((candidate) => candidate.hash === hash)
  return approval ? { state: 'approved', hash, approval } : { state: 'unapproved', hash }
}

/** Why `standing` stops a command, with what to run; `consequence` says what the command would otherwise have done. */
export function describeUnapproved(planPath: string, standing: Exclude<PlanApprovalStanding, { state: 'approved' }>, consequence: string): string {
  if (standing.state === 'unreadable') {
    return `${standing.reason}\nNo approval of ${planPath} can be read, so ${consequence}. Fix the approvals file, then run this again.`
  }
  return `${planPath} is not approved at its current hash ${standing.hash}, so ${consequence}: it was edited after approval, or never approved, and what it says now may not be what anyone agreed to. Run guren plan:approve ${planPath} once the plan says what you mean to build.`
}

/**
 * The approval naming a stamped plan's current hash (RFC 0030 §4), or a refusal that says what
 * to run. A draft has no hash to approve, so callers that accept drafts ask `hasBaseline()` first.
 * An approvals file that will not read refuses too: an approval nobody can read approves nothing.
 */
export async function requirePlanApproval(planPath: string, plan: Plan, consequence: string): Promise<{ hash: string; approval: PlanApproval }> {
  const standing = await readPlanApprovalStanding(planPath, plan)
  if (standing.state !== 'approved') throw new CliError(describeUnapproved(planPath, standing, consequence))
  return { hash: standing.hash, approval: standing.approval }
}
