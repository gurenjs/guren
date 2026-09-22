/**
 * A plan's approvals (RFC 0030 §4, §9): `{ hash, approvedAt, approvedBy }` beside the plan,
 * never inside it, since approval metadata is outside the hash it names. Committed, like the
 * decision log: who approved is also who the repository's history says committed it.
 */

import { z } from 'zod'

import { CliError } from '../cli-error'
import { planSiblingPath, readBesideRecord, writeFileAtomic, type BesideRecordRead } from './beside'
import { planHash } from './identity'
import { hasBaseline } from './render'
import type { Plan, PlanDraft } from './schema'

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
  const approval = approvals.find((candidate) => candidate.hash === hash)
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
