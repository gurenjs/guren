import { Controller, agentApprovalStatusAt } from '@guren/core'

import { AgentApproval } from '../../Models/AgentApproval'
import { User } from '../../Models/User'
import { approvalStore, toApprovalRequest, type ApprovalRow } from '../../Services/DrizzleApprovalStore'
import {
  ApprovalIdParamSchema,
  PruneApprovalsSchema,
  ResolveApprovalSchema,
} from '../Validators/ApprovalValidator'

/** How many stored-pending rows one listing scans, newest first. */
const PENDING_LIMIT = 50

/** How many resolved requests the list carries back, newest first. */
const RESOLVED_LIMIT = 20

/** How old a settled request must be before `prune` removes it, by default. */
const PRUNE_AFTER_DAYS = 7

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * A pending row's `status` is derived: `agentApprovalStatusAt` applies expiry
 * against a clock, so an operator sees the verdict the gate will. The
 * resolution fields are read off the row, not the request: an operator sees an
 * explicit `null`, where the request record drops the key.
 */
function present(row: ApprovalRow, now: Date) {
  const request = toApprovalRequest(row)
  return {
    id: request.id,
    tool: request.tool,
    input: request.input,
    principal: request.principalKey,
    requestedAt: request.requestedAt,
    expiresAt: request.expiresAt,
    // Derived only while pending: that is where expiry matters. An answered
    // row keeps its answer — an approval spent a week ago is history, not lapsed.
    status: request.status === 'pending' ? agentApprovalStatusAt(request, now) : request.status,
    resolvedAt: row.resolvedAt,
    resolvedBy: row.resolvedBy,
    consumed: row.consumedAt !== null,
  }
}

export default class ApprovalController extends Controller {
  async index(): Promise<Response> {
    const now = new Date()
    // Both lists are bounded: this table only grows, and `prune` is the one
    // thing that shrinks it. The stored column is all SQL can filter on, so a
    // lapsed row comes back here and is dropped below rather than offered as
    // answerable.
    const stored = (await AgentApproval.where('status', 'pending')
      .orderBy('requestedAt', 'desc')
      .limit(PENDING_LIMIT)
      .get()) as ApprovalRow[]
    const resolved = (await AgentApproval.where('status', '!=', 'pending')
      .orderBy('requestedAt', 'desc')
      .limit(RESOLVED_LIMIT)
      .get()) as ApprovalRow[]

    return this.json({
      pending: stored.map((row) => present(row, now)).filter((row) => row.status === 'pending'),
      resolved: resolved.map((row) => present(row, now)),
    })
  }

  async approve(): Promise<Response> {
    return this.resolve('approved')
  }

  async reject(): Promise<Response> {
    return this.resolve('rejected')
  }

  /**
   * Housekeeping an operator asks for. Nothing prunes on its own: a request is
   * this application's audit trail of what an agent was allowed to do.
   */
  async prune(): Promise<Response> {
    const { olderThanDays } = await this.validateBody(PruneApprovalsSchema)
    const before = new Date(Date.now() - (olderThanDays ?? PRUNE_AFTER_DAYS) * DAY_MS)

    return this.json({
      pruned: await approvalStore.pruneSettled(before),
      before: before.toISOString(),
    })
  }

  /**
   * Only a `pending` row is answerable. Re-answering an approved one would
   * hand the agent a second grant for a call a human authorized once, and
   * answering a lapsed one would report success for a grant already unusable.
   */
  private async resolve(status: 'approved' | 'rejected'): Promise<Response> {
    const { id } = this.validateParams(ApprovalIdParamSchema)
    await this.validateBody(ResolveApprovalSchema)

    const now = new Date()
    const row = (await AgentApproval.find(id)) as ApprovalRow | null
    if (!row) {
      return this.json({ error: 'No approval request with that id.' }, { status: 404 })
    }

    // Derived, because the column cannot express expiry: a lapsed request still
    // reads `pending` in SQL, and answering it would tell an operator the agent
    // may now act when `agentApprovalUsableAt` will refuse the grant.
    const current = agentApprovalStatusAt(toApprovalRequest(row), now)
    if (current !== 'pending') {
      return this.json({ error: refusal(current), status: current }, { status: 409 })
    }

    const updated = (await AgentApproval.where('id', id)
      .where('status', 'pending')
      .update({
        status,
        resolvedAt: now.toISOString(),
        resolvedBy: await this.operatorName(),
      })) as ApprovalRow | undefined

    if (!updated) {
      // Answered by someone else between the read and this write.
      return this.json({ error: refusal('answered'), status: 'answered' }, { status: 409 })
    }
    return this.json({ approval: present(updated, now) })
  }

  private async operatorName(): Promise<string> {
    const principal = await this.auth.userOrFail<{ id: number }>()
    const user = (await User.find(principal.id)) as { name: string } | null
    return user?.name ?? `user:${principal.id}`
  }
}

function refusal(current: string): string {
  return current === 'expired'
    ? 'That request expired before it was answered. The agent asks again on its next sweep.'
    : `That request was already ${current}.`
}
