/**
 * The pending-approval ledger (RFC 0017 §5): the retry material for a call a
 * human has not answered yet.
 *
 * The approval queue stores only redacted input and a non-reversible
 * fingerprint, so it can never repeat the call — the agent side owns the
 * arguments. A deliberate, bounded exception to RFC 0016's "no reversible copy
 * of arguments": per-instance storage no API surfaces, rows purged when their
 * approval settles or expires, ciphertext at rest.
 */
import { DEFAULT_AGENT_APPROVAL_TTL_MS } from '@guren/core'

/** What the SDK's `sql` tagged template accepts and returns. */
export type LedgerSqlValue = string | number | boolean | null

/**
 * A synchronous tagged-template SQL executor — `Agent.sql`'s exact shape, so
 * the Durable Object passes its own method and a Bun test passes `bun:sqlite`.
 */
export type LedgerSql = (
  strings: TemplateStringsArray,
  ...values: LedgerSqlValue[]
) => Array<Record<string, LedgerSqlValue>>

/** Reversible encryption for the arguments column. `Encrypter`'s string half. */
export interface LedgerCipher {
  encrypt(text: string): string
  decrypt(text: string): string
}

/** A row whose arguments no key on hand can open. */
export interface UnreadablePendingCall {
  requestId: string
  tool: string
}

/** One parked call, as the agent checkpointed it. */
export interface PendingToolCall {
  requestId: string
  tool: string
  args: Record<string, unknown>
  requestedAt: string
  /** ISO 8601 — the *queue's* expiry, never extended by the ledger. */
  expiresAt: string
  /** How many times {@link PendingCallLedger.bumpChecks} has counted this row. */
  checks: number
}

/** First backoff step, doubling per check. */
const BASE_DELAY_SECONDS = 30

/**
 * Added past the earliest expiry so the final wake sees an expired record and
 * prunes it, rather than landing on the instant it lapses and rescheduling.
 */
const EXPIRY_GRACE_SECONDS = 5

/** A schedule must be in the future: a delay of zero is a hot alarm loop. */
const MIN_DELAY_SECONDS = 1

/**
 * A backstop only: the *default* TTL, not any row's own. What actually bounds a
 * wake by a request's life is the earliest `expires_at` each call computes.
 */
const MAX_DELAY_SECONDS = Math.floor(DEFAULT_AGENT_APPROVAL_TTL_MS / 1000)

/**
 * The rows one agent instance is waiting on.
 *
 * Lazily creates its table: `CREATE TABLE IF NOT EXISTS` is the framework's own
 * bookkeeping, not an application table — RFC 0017 Open Question 5 (how *app*
 * schemas migrate across deploys) is untouched by it.
 */
export class PendingCallLedger {
  #created = false

  constructor(
    private readonly sql: LedgerSql,
    private readonly cipher: LedgerCipher,
  ) {}

  /**
   * Checkpoint a call the queue parked.
   *
   * Replacing a row under the same id resets its `checks`, which is what an
   * agent re-calling a parked tool produces: a fresh call is fresh interest,
   * and the backoff restarts with it.
   */
  record(call: Omit<PendingToolCall, 'checks'>): void {
    this.#ensureTable()
    const args = this.cipher.encrypt(JSON.stringify(call.args))
    void this.sql`INSERT OR REPLACE INTO guren_pending_tool_calls
      (request_id, tool, args, requested_at, expires_at, checks)
      VALUES (${call.requestId}, ${call.tool}, ${args}, ${call.requestedAt}, ${call.expiresAt}, 0)`
  }

  /**
   * Every row whose arguments can still be read, oldest request first.
   *
   * An undecryptable row is skipped, not thrown over: one would otherwise take
   * down the sweep *and* the record path, which reads this to pick its next
   * wake. {@link pruneUnreadable} reports and clears them.
   */
  all(): PendingToolCall[] {
    const readable: PendingToolCall[] = []
    for (const row of this.#rows()) {
      const args = this.#decrypt(row)
      if (!args) continue
      readable.push({
        requestId: String(row.request_id),
        tool: String(row.tool),
        args,
        requestedAt: String(row.requested_at),
        expiresAt: String(row.expires_at),
        checks: Number(row.checks),
      })
    }
    return readable
  }

  /**
   * Drop every row whose arguments cannot be decrypted, returning what was
   * dropped. An app key rotated past its `previousKeys`, or a corrupt column:
   * the queue may still hold the request, but nothing here can retry it.
   */
  pruneUnreadable(): UnreadablePendingCall[] {
    const unreadable: UnreadablePendingCall[] = []
    for (const row of this.#rows()) {
      if (this.#decrypt(row)) continue
      unreadable.push({ requestId: String(row.request_id), tool: String(row.tool) })
    }
    for (const call of unreadable) this.remove(call.requestId)
    return unreadable
  }

  remove(requestId: string): void {
    this.#ensureTable()
    void this.sql`DELETE FROM guren_pending_tool_calls WHERE request_id = ${requestId}`
  }

  bumpChecks(requestId: string): void {
    this.#ensureTable()
    void this.sql`UPDATE guren_pending_tool_calls SET checks = checks + 1 WHERE request_id = ${requestId}`
  }

  /**
   * When to wake next, in seconds, or `undefined` when nothing is waiting.
   *
   * Exponential from the **least-checked** row: one wake asks about every row,
   * so the cadence serves the newest parked call rather than inheriting the
   * oldest row's stretched backoff. Capped by the earliest expiry.
   */
  nextDelaySeconds(now: Date): number | undefined {
    const calls = this.all()
    if (calls.length === 0) return undefined

    const checks = Math.min(...calls.map((call) => call.checks))
    const backoff = BASE_DELAY_SECONDS * 2 ** Math.min(checks, 20)

    const earliest = Math.min(...calls.map((call) => Date.parse(call.expiresAt) || 0))
    const untilExpiry = Math.ceil((earliest - now.getTime()) / 1000) + EXPIRY_GRACE_SECONDS

    return Math.max(MIN_DELAY_SECONDS, Math.min(backoff, untilExpiry, MAX_DELAY_SECONDS))
  }

  #rows(): Array<Record<string, LedgerSqlValue>> {
    this.#ensureTable()
    return this.sql`SELECT * FROM guren_pending_tool_calls ORDER BY requested_at ASC, request_id ASC`
  }

  /** @returns the arguments, or `undefined` when the row cannot be read. */
  #decrypt(row: Record<string, LedgerSqlValue>): Record<string, unknown> | undefined {
    try {
      return JSON.parse(this.cipher.decrypt(String(row.args))) as Record<string, unknown>
    } catch {
      return undefined
    }
  }

  #ensureTable(): void {
    if (this.#created) return
    void this.sql`CREATE TABLE IF NOT EXISTS guren_pending_tool_calls (
      request_id TEXT PRIMARY KEY,
      tool TEXT NOT NULL,
      args TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      checks INTEGER NOT NULL DEFAULT 0
    )`
    this.#created = true
  }
}

/**
 * Whether a row's copied `expires_at` has passed.
 *
 * An unparseable date counts as expired, the direction `agentApprovalExpiredAt`
 * fails in. A row past this can never be retried — `agentApprovalUsableAt`
 * refuses an expired approval — so the sweep asks about it once and drops it.
 */
export function hasExpired(expiresAt: string, now: Date): boolean {
  const at = Date.parse(expiresAt)
  return Number.isNaN(at) || at <= now.getTime()
}

/**
 * Whether a check at `now + delaySeconds` fires sooner than every pending one.
 *
 * A row expiring in five minutes must not be left to a check twenty minutes
 * out. `times` are Unix **seconds**, the unit `Schedule.time` carries.
 */
export function firesSooner(
  delaySeconds: number,
  now: Date,
  times: readonly number[],
): boolean {
  const at = Math.floor(now.getTime() / 1000) + delaySeconds
  // An unreadable time is treated as "no useful schedule", so the new one wins:
  // the opposite would let one bad row suppress every later check.
  return times.every((existing) => !Number.isFinite(existing) || at < existing)
}
