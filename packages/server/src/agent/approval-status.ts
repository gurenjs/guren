/**
 * Reading one approval record as an answer for the caller that asked
 * (RFC 0016 §5.4 item 4). Pure derivation, like `approval.ts`: no store, no
 * clock, no protocol.
 *
 * Here rather than in an adapter because two surfaces answer this question —
 * `guren.approval_status` over MCP and a durable agent's own status check
 * (RFC 0017 §5) — and a record one of them calls "approved" must not be one
 * the other hides.
 */
import {
  agentApprovalStatusAt,
  agentApprovalVisibleTo,
  type AgentApprovalRequest,
} from './approval'
import type { AgentPrincipal } from './events'

/** One answer about one request. */
export interface ApprovalStatusReport {
  [key: string]: unknown
  requestId: string
  status: string
  tool: string
  requestedAt: string
  expiresAt: string
  executed: false
  resolvedAt?: string
  resolvedBy?: string
  /**
   * When the approval was spent, if it has been. An approved record carrying
   * this authorizes nothing further — the one call it permitted has run, and
   * repeating that call files a fresh request rather than reusing this one.
   */
  consumedAt?: string
}

/**
 * The one message for "there is no such request *for you*". One function for
 * both branches because an unknown id and another principal's id must be the
 * same answer byte for byte: any difference turns the check into a way to
 * enumerate other principals' pending actions. The audit trail is where the
 * distinction is kept, for the operator.
 */
export function approvalStatusNotFoundMessage(requestId: string): string {
  return `No approval request with id "${requestId}" was made by this caller.`
}

export type ApprovalStatusOutcome =
  | { report: ApprovalStatusReport }
  /**
   * Unknown, or not this caller's — one answer to the caller. `foreign` is the
   * half the *operator* gets: it rides beside the message, for the audit event,
   * and must never reach the result.
   */
  | { notFound: string; foreign: boolean }

/**
 * Read a stored record as an answer for `principal` at `now`. `record === null`
 * and "not visible to this principal" converge here rather than at two call
 * sites, so their sameness is structural.
 */
export function toApprovalStatusReport(
  requestId: string,
  record: AgentApprovalRequest | null,
  principal: AgentPrincipal | null,
  now: Date,
): ApprovalStatusOutcome {
  if (!record || !agentApprovalVisibleTo(record, principal)) {
    return { notFound: approvalStatusNotFoundMessage(requestId), foreign: record !== null }
  }

  return {
    report: {
      requestId: record.id,
      status: agentApprovalStatusAt(record, now),
      tool: record.tool,
      requestedAt: record.requestedAt,
      expiresAt: record.expiresAt,
      executed: false,
      ...(record.resolvedAt ? { resolvedAt: record.resolvedAt } : {}),
      ...(record.resolvedBy ? { resolvedBy: record.resolvedBy } : {}),
      ...(record.consumedAt ? { consumedAt: record.consumedAt } : {}),
    },
  }
}
