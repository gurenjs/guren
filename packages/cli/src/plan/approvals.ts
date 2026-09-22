/**
 * A plan's approvals (RFC 0030 §4, §9): `{ hash, approvedAt, approvedBy }` beside the plan,
 * never inside it, since approval metadata is outside the hash it names. Committed, like the
 * decision log: who approved is also who the repository's history says committed it.
 */

import { writeFile } from 'node:fs/promises'

import { z } from 'zod'

import { CliError } from '../cli-error'
import { planSiblingPath, readBesideRecord, type BesideRecordRead } from './beside'

export const PLAN_APPROVALS_VERSION = 1

const PlanApprovalSchema = z.object({
  /** `planHash()` of the approved plan, baseline included. */
  hash: z.string(),
  approvedAt: z.string(),
  /** Whoever `git config` named, where it answered. */
  approvedBy: z.string().optional(),
})

export const PlanApprovalsSchema = z.object({
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

/** Refuses a file that would not read rather than replacing it: it is a committed record nobody can rebuild. */
export function requireReadableApprovals(read: BesideRecordRead<PlanApprovals>): PlanApprovals {
  if (read.unreadable) {
    throw new CliError(`${read.unreadable}\nThe approvals file is a committed record, so this command will not replace it. Fix the file, then run this again.`)
  }
  return read.value ?? { approvalsVersion: PLAN_APPROVALS_VERSION, approvals: [] }
}

/** Appends in the order approvals were given; an approval of a hash already approved is returned and nothing is written. */
export async function recordPlanApproval(planPath: string, approval: PlanApproval): Promise<{ written: boolean; existing?: PlanApproval }> {
  const approvals = requireReadableApprovals(await readPlanApprovals(planPath))
  const existing = approvals.approvals.find((candidate) => candidate.hash === approval.hash)
  if (existing) return { written: false, existing }
  approvals.approvals.push(approval)
  await writeFile(planApprovalsPath(planPath), `${JSON.stringify(approvals, null, 2)}\n`, 'utf8')
  return { written: true }
}
