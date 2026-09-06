/**
 * `AgentApprovalStore` over a table (RFC 0016 §5.4, RFC 0017 §5).
 *
 * The framework ships no default, because a queue degrading to process memory
 * on Workers would answer "approved" for a record the next isolate never heard
 * of. Nothing here filters expiry or status: `agentApprovalStatusAt` and
 * `agentApprovalUsableAt` own those rules, and a second copy in SQL is the copy
 * that fails open.
 */
import type {
  AgentApprovalMatch,
  AgentApprovalRequest,
  AgentApprovalStore,
  AgentPrincipal,
} from '@guren/core'

import { AgentApproval } from '../Models/AgentApproval'

export type ApprovalRow = {
  id: string
  tool: string
  input: Record<string, unknown>
  fingerprint: string
  principal: AgentPrincipal | null
  principalKey: string
  requestedAt: string
  expiresAt: string
  status: AgentApprovalRequest['status']
  resolvedAt: string | null
  resolvedBy: string | null
  consumedAt: string | null
}

/** SQL keeps `null` for "not yet"; the interface's optional fields drop the key. */
export function toApprovalRequest(row: ApprovalRow): AgentApprovalRequest {
  return {
    id: row.id,
    tool: row.tool,
    input: row.input,
    fingerprint: row.fingerprint,
    principal: row.principal,
    principalKey: row.principalKey,
    requestedAt: row.requestedAt,
    expiresAt: row.expiresAt,
    status: row.status,
    ...(row.resolvedAt ? { resolvedAt: row.resolvedAt } : {}),
    ...(row.resolvedBy ? { resolvedBy: row.resolvedBy } : {}),
    ...(row.consumedAt ? { consumedAt: row.consumedAt } : {}),
  }
}

export class DrizzleApprovalStore implements AgentApprovalStore {
  /** `forceCreate`: every column is written from the framework's own record. */
  async create(request: AgentApprovalRequest): Promise<void> {
    await AgentApproval.forceCreate({
      id: request.id,
      tool: request.tool,
      input: request.input,
      fingerprint: request.fingerprint,
      principal: request.principal,
      principalKey: request.principalKey,
      requestedAt: request.requestedAt,
      expiresAt: request.expiresAt,
      status: request.status,
      resolvedAt: request.resolvedAt ?? null,
      resolvedBy: request.resolvedBy ?? null,
      consumedAt: request.consumedAt ?? null,
    })
  }

  async find(id: string): Promise<AgentApprovalRequest | null> {
    const row = (await AgentApproval.find(id)) as ApprovalRow | null
    return row ? toApprovalRequest(row) : null
  }

  /**
   * Unconsumed only, newest first. Deliberately not "the approved one": the
   * gate must see a pending match too, or an agent polling by re-calling the
   * tool files a fresh record and pages a human once per poll.
   */
  async findMatch(match: AgentApprovalMatch): Promise<AgentApprovalRequest | null> {
    const rows = (await AgentApproval.where({
      tool: match.tool,
      fingerprint: match.fingerprint,
      principalKey: match.principalKey,
    })
      .whereNull('consumedAt')
      .orderBy('requestedAt', 'desc')
      .limit(1)
      .get()) as ApprovalRow[]
    return rows[0] ? toApprovalRequest(rows[0]) : null
  }

  /**
   * Compare-and-set: the `consumed_at IS NULL` predicate is inside the UPDATE,
   * so two concurrent calls cannot both win one approval. The verdict is
   * whether a row came back — drizzle's UPDATE … RETURNING answers with the
   * changed row on bun:sqlite and on D1 alike, where a separate SELECT would
   * be a second statement to race in.
   */
  async consume(id: string): Promise<boolean> {
    const updated = await AgentApproval.where('id', id)
      .whereNull('consumedAt')
      .update({ consumedAt: new Date().toISOString() })
    return updated != null
  }

  /**
   * Delete every unanswerable request older than `olderThan`, returning how
   * many went. Not part of `AgentApprovalStore`: nothing in the framework
   * prunes an application's table, so this app's operator API
   * (`POST /approvals/prune`) is what calls it.
   */
  async pruneSettled(olderThan: Date): Promise<number> {
    const cut = olderThan.toISOString()
    // Two shapes of unanswerable and only one of them is a column: `expired` is
    // derived by `agentApprovalStatusAt`, so a lapsed request still reads
    // `pending` in SQL and a status filter alone would never collect it.
    const answered = (await AgentApproval.where('status', '!=', 'pending')
      .where('requestedAt', '<', cut)
      .get()) as ApprovalRow[]
    const lapsed = (await AgentApproval.where('status', 'pending')
      .where('expiresAt', '<', cut)
      .get()) as ApprovalRow[]

    const ids = [...new Set([...answered, ...lapsed].map((row) => row.id))]
    // Counted before the delete: `deleteAdvanced` answers with a returned row
    // on sqlite, not a row count, so the delete cannot report this itself.
    if (ids.length > 0) await AgentApproval.whereIn('id', ids).delete()
    return ids.length
  }
}

export const approvalStore = new DrizzleApprovalStore()
