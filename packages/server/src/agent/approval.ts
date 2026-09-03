/**
 * The agent approval queue (RFC 0016 §5.4 item 4): a tool declaring
 * `approval: 'required'` does not execute on request — the call becomes a
 * pending record, approvers are notified, and only a *human* decision turns it
 * into permission for one later call.
 *
 * Declarations and pure derivation only, like `audit.ts`: no database, no
 * clock, no notification. {@link AgentApprovalRequest.input} arrives already
 * through `redactAgentArguments` and must not be masked again; the
 * *fingerprint* is computed from the **raw** arguments instead, or approving
 * `users.setPassword {id: 5, password: '…'}` would authorize the same call
 * with a different password.
 */
import type { AgentPrincipal } from './events'

/**
 * How long a pending request stays answerable by default: one hour. An approval
 * is permission for one call *now*, not a standing grant.
 */
export const DEFAULT_AGENT_APPROVAL_TTL_MS = 60 * 60 * 1000

/**
 * The configuration key an adapter reads the queue out of, as a value.
 *
 * `guren check` finds the `mcpPlugin({ … })` call by this key, and the CLI
 * cannot import `@guren/plugin-mcp` — restating the string would let a rename
 * leave the check passing every app silently. Same rule, two readers, as
 * {@link file://./meta-tools.ts}.
 */
export const AGENT_APPROVAL_CONFIG_KEY = 'approvals'

/**
 * What a request is waiting for, or what happened to it. `'expired'` is a
 * *stored* status only for a store that sweeps; {@link agentApprovalStatusAt}
 * derives expiry from `expiresAt` against a clock, so a store that never
 * sweeps and one that sweeps hourly answer the same way.
 */
export type AgentApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired'

/** One pending, answered, or spent approval request. */
export interface AgentApprovalRequest {
  /** Opaque identity, quoted back to the caller so it can poll. */
  id: string
  /** The tool the call addressed, by its catalogue name. */
  tool: string
  /**
   * The call's arguments **already redacted** — see the module header. Shown
   * to the approver and persisted; never what the match is computed from.
   */
  input: Record<string, unknown>
  /**
   * {@link agentApprovalFingerprint} of the *raw* arguments — the hash, never
   * the canonical string: a store holding a reversible copy of every argument
   * an agent ever passed would be a second place secrets live.
   */
  fingerprint: string
  /** Who asked. `null` for a surface with no verified principal. */
  principal: AgentPrincipal | null
  /**
   * {@link agentApprovalPrincipalKey} of `principal`, denormalized so a store
   * can index the match without knowing how the key is derived.
   */
  principalKey: string
  /** ISO 8601, UTC. */
  requestedAt: string
  /** ISO 8601, UTC. Past this instant the record authorizes nothing. */
  expiresAt: string
  status: AgentApprovalStatus
  /** ISO 8601, UTC — when a human answered. Absent while pending. */
  resolvedAt?: string
  /**
   * Who answered, in whatever vocabulary the application approves in. Never
   * interpreted by the framework; it exists so the answer to "who let this
   * through" is in the record rather than only in the approval UI's logs.
   */
  resolvedBy?: string
  /** ISO 8601, UTC — when the approval was spent. Set by `consume`. */
  consumedAt?: string
}

/** The three fields that identify *this* call for the store's lookup. */
export interface AgentApprovalMatch {
  tool: string
  fingerprint: string
  principalKey: string
}

/**
 * Where pending approvals live. The application implements it; the framework
 * ships no default, because a queue that silently degraded to process memory on
 * Workers or Lambda would answer "approved" for a record the next isolate never
 * heard of. An unconfigured queue refuses visibly instead (`gateToolCall`'s
 * fail-closed refusal names the configuration line).
 *
 * Four methods, each one the gate actually reaches for. No `list`, `approve` or
 * `reject`: resolving a request is a human action taken through the
 * application's own interface, over its own storage.
 */
export interface AgentApprovalStore {
  /** Persist a new pending request. */
  create(request: AgentApprovalRequest): Promise<void>

  /**
   * The request with this id, or `null`. Backs `guren.approval_status`. Takes
   * no principal: the caller-scoping rule is applied by the framework (see
   * {@link agentApprovalVisibleTo}), because a store that forgot to filter
   * would leak other principals' pending actions and nothing would fail.
   */
  find(id: string): Promise<AgentApprovalRequest | null>

  /**
   * The **unconsumed** record matching this exact call, or `null`; the most
   * recently requested when several match. Deliberately not "the approved one":
   * the gate must see a *pending* match too, or an agent polling by re-calling
   * the tool creates unbounded records and notifies approvers once per poll,
   * and a *rejected* one for the same reason. Expiry is not filtered here
   * either — see {@link agentApprovalUsableAt}.
   */
  findMatch(match: AgentApprovalMatch): Promise<AgentApprovalRequest | null>

  /**
   * Spend the approval with this id, returning whether *this* call won it.
   * Must be a compare-and-set: two concurrent calls find the same approved
   * record, and an unconditional write hands it to both. The gate treats
   * `false` as "no approval", not an error, and creates a new pending record.
   */
  consume(id: string): Promise<boolean>
}

/**
 * A stable key for "the same caller". Kind and id only: a token's *abilities*
 * are not part of the identity, so an approval a human granted survives a
 * rotation or re-scope, and the scope gate has already run by the time this key
 * is used. The id's type is part of the key — collapsing `5` and `'5'` would
 * let a service token named `"5"` spend a user 5 approval.
 */
export function agentApprovalPrincipalKey(principal: AgentPrincipal | null): string {
  if (!principal) return 'anonymous'
  return `${principal.kind}:${typeof principal.id === 'number' ? 'n' : 's'}:${principal.id}`
}

/**
 * The canonical text of one call's arguments — the *only* rule for deciding
 * that two calls are the same call. A second serialization is how approving
 * `posts.destroy {id: 5}` comes to authorize `{id: 9}`, and it would do it
 * silently, because both sides still produce *a* string.
 *
 * Normalizes object key order at every depth, and nothing else: types, array
 * order, and absent-vs-explicitly-null each distinguish genuinely different
 * calls. Total over JSON only — a value JSON cannot carry throws rather than
 * serializing to a placeholder that would collapse two distinct inputs, and the
 * gate turns the throw into a fail-closed refusal.
 */
export function canonicalizeAgentApprovalInput(input: Record<string, unknown>): string {
  return canonicalize(input)
}

function canonicalize(value: unknown): string {
  if (value === null) return 'null'

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(
          `Agent approval arguments must be JSON: ${String(value)} is not a finite number.`,
        )
      }
      return JSON.stringify(value)
    case 'string':
      return JSON.stringify(value)
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((entry) => canonicalize(entry)).join(',')}]`
      }
      const record = value as Record<string, unknown>
      // `Object.keys`, not `for…in`: the prototype chain is not part of the
      // arguments, and walking it would let a key inherited from a polluted
      // `Object.prototype` change the fingerprint of every call.
      const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort()
      return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`
    }
    default:
      throw new TypeError(
        `Agent approval arguments must be JSON: a value of type ${typeof value} cannot be `
        + 'fingerprinted, so no approval could be bound to it.',
      )
  }
}

/**
 * The fingerprint an approval is bound to: SHA-256 of
 * {@link canonicalizeAgentApprovalInput}, hex. Hashed rather than stored
 * verbatim because these are the **raw** arguments while the record persists
 * and is shown to a human. Async because `crypto.subtle` is — the one digest
 * available unchanged on Bun, Node and Workers.
 */
export async function agentApprovalFingerprint(input: Record<string, unknown>): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalizeAgentApprovalInput(input))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** What {@link buildAgentApprovalRequest} needs beyond the clock. */
export interface AgentApprovalRequestInput {
  tool: string
  /** Already redacted — see the module header. */
  input: Record<string, unknown>
  /** From {@link agentApprovalFingerprint}, over the *raw* arguments. */
  fingerprint: string
  principal: AgentPrincipal | null
  /** Defaults to {@link DEFAULT_AGENT_APPROVAL_TTL_MS}. */
  ttlMs?: number
}

/**
 * Derive a new pending record. `now` is a parameter because the caller that
 * creates a record also decides whether an existing one has expired, and two
 * clock reads can disagree. The id comes from `crypto.randomUUID()` rather than
 * a parameter: the caller reads it off the returned record, and threading one
 * in would invite two call sites to generate ids differently.
 */
export function buildAgentApprovalRequest(
  request: AgentApprovalRequestInput,
  now: Date,
): AgentApprovalRequest {
  const ttlMs = request.ttlMs ?? DEFAULT_AGENT_APPROVAL_TTL_MS
  return {
    id: crypto.randomUUID(),
    tool: request.tool,
    input: request.input,
    fingerprint: request.fingerprint,
    principal: request.principal,
    principalKey: agentApprovalPrincipalKey(request.principal),
    requestedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    status: 'pending',
  }
}

/**
 * Whether a record has passed its expiry at `now`. An unparseable `expiresAt`
 * counts as expired: treating a date the framework cannot read as "not expired
 * yet" fails open into a permanent approval, and that is the one direction of
 * error nothing outside can notice.
 */
export function agentApprovalExpiredAt(request: AgentApprovalRequest, now: Date): boolean {
  const expiresAt = Date.parse(request.expiresAt)
  return Number.isNaN(expiresAt) || expiresAt <= now.getTime()
}

/**
 * The record's status as of `now`, with expiry applied. Derived here rather
 * than filtered by the store: a second copy of the rule is the one that fails
 * open — a store that forgets to compare, or compares in local time, hands out
 * an approval granted last month and nothing reports it. A resolved record
 * keeps its resolution.
 */
export function agentApprovalStatusAt(
  request: AgentApprovalRequest,
  now: Date,
): AgentApprovalStatus {
  if (request.status === 'rejected') return 'rejected'
  if (agentApprovalExpiredAt(request, now)) return 'expired'
  return request.status
}

/**
 * Whether this record authorizes a call at `now`: approved, unexpired, and not
 * already spent. All three are checked in framework code rather than trusted to
 * the store's query; `consumedAt` too, because the single-use guarantee must
 * not rest on an application's SQL — `consume`'s compare-and-set is the atomic
 * half of it, this is the cheap half.
 */
export function agentApprovalUsableAt(request: AgentApprovalRequest, now: Date): boolean {
  if (request.status !== 'approved') return false
  if (request.consumedAt !== undefined) return false
  return !agentApprovalExpiredAt(request, now)
}

/**
 * Whether `principal` may be told anything at all about `request` — the scope
 * rule of `guren.approval_status` (RFC 0016 §5.4): a caller reads the status
 * only of a request it created. Without it an agent could walk ids and
 * enumerate other principals' pending actions. A record this returns `false`
 * for must be answered *exactly* as an unknown id is: any difference in
 * message, error shape or timing reintroduces the enumeration.
 */
export function agentApprovalVisibleTo(
  request: AgentApprovalRequest,
  principal: AgentPrincipal | null,
): boolean {
  return request.principalKey === agentApprovalPrincipalKey(principal)
}
