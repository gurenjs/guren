/**
 * The operator's view of the approval queue: what one request looks like, what
 * a listing holds, and how a request is answered.
 *
 * Shared by the two operator surfaces — `routes/api.ts`'s JSON and the browser
 * console. One definition, because a console that derived status differently
 * would offer an expired request as answerable, and one that answered a settled
 * row would hand the agent a second grant for a call authorized once.
 */
import { agentApprovalStatusAt } from '@guren/core'

import { AgentApproval } from '../Models/AgentApproval'
import { User } from '../Models/User'
import { toApprovalRequest, type ApprovalRow } from './DrizzleApprovalStore'

/** How many stored-pending rows one listing scans, newest first. */
const PENDING_LIMIT = 50

/** How many resolved requests a listing carries back, newest first. */
const RESOLVED_LIMIT = 20

export interface ApprovalView {
  id: string
  tool: string
  input: Record<string, unknown>
  principal: string
  requestedAt: string
  expiresAt: string
  status: string
  resolvedAt: string | null
  resolvedBy: string | null
  consumed: boolean
}

export interface ApprovalListing {
  pending: ApprovalView[]
  resolved: ApprovalView[]
}

export type ApprovalResolution =
  | { ok: true; approval: ApprovalView }
  | { ok: false; status: string; message: string; httpStatus: 404 | 409 }

/**
 * Derived only while the row still reads `pending`: that is where expiry matters.
 * An answered row keeps its answer, so a refusal names the answer rather than
 * calling an approval spent a week ago lapsed.
 */
function statusAt(request: ReturnType<typeof toApprovalRequest>, now: Date): string {
  return request.status === 'pending' ? agentApprovalStatusAt(request, now) : request.status
}

/**
 * The resolution fields come off the row, not the request: an operator sees an
 * explicit `null` where the request record drops the key.
 */
export function presentApproval(row: ApprovalRow, now: Date): ApprovalView {
  const request = toApprovalRequest(row)
  return {
    id: request.id,
    tool: request.tool,
    input: request.input,
    principal: request.principalKey,
    requestedAt: request.requestedAt,
    expiresAt: request.expiresAt,
    status: statusAt(request, now),
    resolvedAt: row.resolvedAt,
    resolvedBy: row.resolvedBy,
    consumed: row.consumedAt !== null,
  }
}

/**
 * Two bounded queries. This table only grows and `prune` is the one thing that
 * shrinks it. The stored column is all SQL can filter on, so a lapsed row comes
 * back here and is dropped rather than offered as answerable.
 */
export async function listApprovals(now = new Date()): Promise<ApprovalListing> {
  const stored = (await AgentApproval.where('status', 'pending')
    .orderBy('requestedAt', 'desc')
    .limit(PENDING_LIMIT)
    .get()) as ApprovalRow[]
  const resolved = (await AgentApproval.where('status', '!=', 'pending')
    .orderBy('requestedAt', 'desc')
    .limit(RESOLVED_LIMIT)
    .get()) as ApprovalRow[]

  return {
    pending: stored.map((row) => presentApproval(row, now)).filter((row) => row.status === 'pending'),
    resolved: resolved.map((row) => presentApproval(row, now)),
  }
}

/**
 * Only a `pending` row is answerable, and `pending` is derived rather than read:
 * a lapsed request still reads `pending` in SQL, and answering it would tell an
 * operator the agent may now act when `agentApprovalUsableAt` will refuse it.
 */
export async function resolveApproval(
  id: string,
  status: 'approved' | 'rejected',
  resolvedBy: string,
  now = new Date(),
): Promise<ApprovalResolution> {
  const row = (await AgentApproval.find(id)) as ApprovalRow | null
  if (!row) {
    return { ok: false, status: 'missing', message: 'No approval request with that id.', httpStatus: 404 }
  }

  const current = statusAt(toApprovalRequest(row), now)
  if (current !== 'pending') {
    return { ok: false, status: current, message: refusal(current), httpStatus: 409 }
  }

  const updated = (await AgentApproval.where('id', id)
    .where('status', 'pending')
    .update({ status, resolvedAt: now.toISOString(), resolvedBy })) as ApprovalRow | undefined

  if (!updated) {
    // Answered by someone else between the read and this write.
    return { ok: false, status: 'answered', message: refusal('answered'), httpStatus: 409 }
  }
  return { ok: true, approval: presentApproval(updated, now) }
}

/**
 * The name an answered request records, on either operator surface. The console's
 * session guard resolves the whole row; the token guard is configured with no
 * user provider and resolves a bare `{ id }`, which is the only case that reads.
 */
export async function operatorName(user: { id: number | string; name?: string }): Promise<string> {
  if (user.name) return user.name
  const row = (await User.find(user.id)) as { name: string } | null
  return row?.name ?? `user:${user.id}`
}

function refusal(current: string): string {
  return current === 'expired'
    ? 'That request expired before it was answered. The agent asks again on its next sweep.'
    : `That request was already ${current}.`
}
