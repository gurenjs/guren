/**
 * The agent approval queue (RFC 0016 §5.4 item 4): a tool declaring
 * `approval: 'required'` does not execute on request. The call becomes a
 * pending record, approvers are notified, and only a *human* decision turns
 * that record into permission for one later call.
 *
 * Declarations and pure derivation only, exactly as {@link file://./audit.ts}
 * beside it. Nothing here opens a database, reads a clock, or sends a
 * notification — every function that needs the instant takes it as an
 * argument, because this module is reachable from every runtime the framework
 * targets and because a rule that timestamped itself could not be pinned by a
 * test. *Where* records live is the application's decision, made once through
 * {@link AgentApprovalStore}; this module only says what one looks like and
 * what makes one usable.
 *
 * **Redaction is the emitter's contract, and nothing here may re-run it.**
 * {@link AgentApprovalRequest.input} arrives having already been through
 * `redactAgentArguments`, the same contract `events.ts` and `audit.ts` state:
 * a record is shown to a human approver and is persisted, so it carries the
 * masked copy. Masking again here would install a second, quieter redaction
 * rule beside the real one, and nothing reading a record could tell which of
 * them produced a mask it is looking at.
 *
 * That contract is exactly why the *fingerprint* is computed from the **raw**
 * arguments instead (see {@link agentApprovalFingerprint}). Binding an
 * approval to the redacted copy would make approving
 * `users.setPassword {id: 5, password: '…'}` authorize the same call with a
 * different password, since the two redact to the same object — the hole the
 * argument-binding rule exists to close.
 */
import type { AgentPrincipal } from './events'

/**
 * How long a pending request stays answerable by default: one hour.
 *
 * An approval is permission for one call *now*, not a standing grant. The
 * default is short for the reason the single-use rule exists — an approval
 * granted last month must not let a call through today — and an application
 * that wants longer says so.
 */
export const DEFAULT_AGENT_APPROVAL_TTL_MS = 60 * 60 * 1000

/**
 * The configuration key an adapter reads the queue out of, as a value.
 *
 * `guren check` fails a route declaring `approval: 'required'` in an app whose
 * `mcpPlugin({ … })` call carries no queue, and it finds that call by looking
 * for this key. The CLI cannot import `@guren/plugin-mcp` — it does not depend
 * on it, and an app that never installs App MCP is still checked — so without
 * this constant the check would restate the string and the two would drift:
 * renaming the option would leave the check passing every app, silently. Same
 * rule, two readers, as {@link file://./meta-tools.ts}.
 */
export const AGENT_APPROVAL_CONFIG_KEY = 'approvals'

/**
 * What a request is waiting for, or what happened to it.
 *
 * `'expired'` is a *stored* status only for a store that sweeps; the framework
 * never depends on one having done so — {@link agentApprovalStatusAt} derives
 * expiry from `expiresAt` against a clock, so a store that never sweeps and one
 * that sweeps hourly answer the same question the same way.
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
   * {@link agentApprovalFingerprint} of the *raw* arguments. The record
   * carries the hash and never the canonical string: an approval store holding
   * a reversible copy of every argument an agent ever passed would be a second
   * place secrets live, and the redaction above exists precisely so the first
   * one does not.
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
   * Who answered, in whatever vocabulary the application approves in (a user
   * id, an email, a console operator's name). The framework never interprets
   * it; it exists so the audit answer to "who let this through" is in the
   * record rather than only in the approval UI's own logs.
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
 * ships no default, for the reason the audit sink ships none: the runtimes
 * this endpoint serves include Workers and Lambda, and a queue that silently
 * degraded to process memory there would answer "approved" for a record the
 * next isolate has never heard of. An unconfigured queue refuses visibly
 * instead (`gateToolCall`'s fail-closed refusal names the configuration line).
 *
 * Four methods, each one the gate actually reaches for. Deliberately no
 * `list`, `approve`, or `reject`: resolving a request is a human action taken
 * through the application's own interface, over the application's own storage,
 * and a framework interface for it would be a second way to write records that
 * nothing here reads.
 */
export interface AgentApprovalStore {
  /** Persist a new pending request. */
  create(request: AgentApprovalRequest): Promise<void>

  /**
   * The request with this id, or `null`. Backs `guren.approval_status`.
   *
   * Takes no principal: the caller-scoping rule is applied by the framework
   * (see {@link agentApprovalVisibleTo}), not by the store, because a store
   * that forgot to filter would leak other principals' pending actions and
   * nothing would fail.
   */
  find(id: string): Promise<AgentApprovalRequest | null>

  /**
   * The **unconsumed** record matching this exact call, or `null`. When more
   * than one matches, the most recently requested.
   *
   * Deliberately not "the approved one": the gate needs to see a *pending*
   * match too, or an agent that polls by re-calling the tool creates an
   * unbounded number of records and notifies approvers once per poll. It needs
   * to see a *rejected* one for the same reason. Expiry is not filtered here
   * either — see {@link agentApprovalUsableAt}.
   */
  findMatch(match: AgentApprovalMatch): Promise<AgentApprovalRequest | null>

  /**
   * Spend the approval with this id, returning whether *this* call won it.
   *
   * Must be a compare-and-set: set `consumedAt` only if it is not already set,
   * and answer `false` when it was. Two concurrent calls will find the same
   * approved record — an approval is permission for one call, and a `consume`
   * implemented as an unconditional write hands it to both. The gate treats
   * `false` as "no approval", not as an error, and falls through to creating a
   * new pending record.
   */
  consume(id: string): Promise<boolean>
}

/**
 * A stable key for "the same caller".
 *
 * Kind and id only: a token's *abilities* are not part of the identity,
 * because a token rotated or re-scoped between the approval and the call is
 * still the same principal, and an approval a human granted should not
 * evaporate because an unrelated ability was added. The scope gate has already
 * run by the time this key is used, so the call's own authority is checked
 * regardless.
 *
 * The id's type is part of the key. `id: 5` and `id: '5'` are different
 * principals to every store that distinguishes them, and collapsing the two
 * here would let a service token named `"5"` spend a user 5 approval.
 */
export function agentApprovalPrincipalKey(principal: AgentPrincipal | null): string {
  if (!principal) return 'anonymous'
  return `${principal.kind}:${typeof principal.id === 'number' ? 'n' : 's'}:${principal.id}`
}

/**
 * The canonical text of one call's arguments — the *only* rule for deciding
 * that two calls are the same call.
 *
 * One function, two readers: {@link agentApprovalFingerprint} hashes it when a
 * record is created and again when a call looks one up. A second
 * serialization is how approving `posts.destroy {id: 5}` comes to authorize
 * `{id: 9}` — the failure this whole binding exists to prevent — and it would
 * do it silently, because both sides would still produce *a* string.
 *
 * What it normalizes: object key order, at every depth. `{a: 1, b: 2}` and
 * `{b: 2, a: 1}` are the same call, nested or not.
 *
 * What it deliberately does **not** normalize, because each would make two
 * genuinely different calls match:
 *
 * - **Types.** `{id: 5}` and `{id: '5'}` are different calls. A route that
 *   coerces them to the same value is coercing *after* the gate; the approver
 *   saw one of the two written down.
 * - **Array order.** Order is meaning in a JSON array (`ids: [1, 2]` vs
 *   `[2, 1]` may be the same call to one route and not to another) and the
 *   framework cannot know which.
 * - **Absent vs. explicitly null.** A dropped key and `null` are different
 *   inputs to a schema with a default.
 * - Unicode form, number spelling beyond what JSON already fixes, or
 *   whitespace inside strings.
 *
 * Total over JSON, and deliberately *not* total over everything else: a value
 * JSON cannot carry throws rather than serializing to a placeholder. A
 * placeholder would make two distinct inputs canonicalize identically, which
 * is the one failure mode worse than refusing — and refusing is safe here,
 * because the gate turns a throw into a fail-closed refusal. Arguments reach
 * this function parsed from JSON-RPC, so no such value can occur in practice;
 * the rule is written down for the surface that one day passes one.
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
 * {@link canonicalizeAgentApprovalInput}, hex.
 *
 * Hashed rather than stored verbatim because the record persists and is shown
 * to a human, while these are the **raw** arguments — the ones the record's
 * own `input` field is redacted precisely to keep out of storage. The hash
 * binds the approval without keeping the secret.
 *
 * Async because `crypto.subtle` is: it is the one digest available unchanged
 * on every runtime the framework targets (Bun, Node, Workers), and the gate is
 * async already.
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
 * Derive a new pending record.
 *
 * `now` is a parameter for the reason `toAuditRecord`'s is: the caller that
 * creates a record also decides whether an existing one has expired, and two
 * clock reads can disagree — a record stamped a millisecond after the instant
 * its own expiry was measured against.
 *
 * The id comes from `crypto.randomUUID()` rather than a parameter, which is
 * not the same compromise: an id needs no seam to be testable, since the
 * caller reads it straight off the returned record, and threading one in from
 * every call site would invite two of them to generate ids differently.
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
 * Whether a record has passed its expiry at `now`.
 *
 * An unparseable `expiresAt` counts as expired. The alternative — treating a
 * date the framework cannot read as "not expired yet" — is a store bug that
 * fails open into a permanent approval, and this is the one direction of error
 * that cannot be noticed from the outside.
 */
export function agentApprovalExpiredAt(request: AgentApprovalRequest, now: Date): boolean {
  const expiresAt = Date.parse(request.expiresAt)
  return Number.isNaN(expiresAt) || expiresAt <= now.getTime()
}

/**
 * The record's status as of `now`, with expiry applied.
 *
 * Expiry is derived here rather than filtered by the store on purpose: a store
 * that judged it would be a second copy of the rule, and the copy that fails
 * open — a store that forgets to compare, or compares in local time, hands out
 * an approval granted last month and nothing anywhere reports it. A resolved
 * record keeps its resolution: a rejection does not become an expiry, and an
 * approval that was already spent is reported by `consumedAt`, not by this.
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
 * Whether this record authorizes a call at `now`: approved, unexpired, and
 * not already spent.
 *
 * All three are checked here, in framework code, rather than trusted to the
 * store's query — see {@link AgentApprovalStore.findMatch}. `consumedAt` is
 * checked even though `findMatch` promises unconsumed records, because the
 * single-use guarantee must not rest on an application's SQL: the *atomic*
 * half of it is `consume`'s compare-and-set, and this is the cheap half.
 */
export function agentApprovalUsableAt(request: AgentApprovalRequest, now: Date): boolean {
  if (request.status !== 'approved') return false
  if (request.consumedAt !== undefined) return false
  return !agentApprovalExpiredAt(request, now)
}

/**
 * Whether `principal` may be told anything at all about `request`.
 *
 * The scope rule of `guren.approval_status` (RFC 0016 §5.4): a caller reads
 * the status only of a request it created. Without it the tool is a way to
 * enumerate other principals' pending actions — an agent could walk ids and
 * learn what a colleague is waiting to have approved, which is both the
 * content of the request and the fact that it exists.
 *
 * A record this returns `false` for must be answered *exactly* as an unknown
 * id is. Any difference between the two answers — a distinct message, a
 * different error shape, a slower path — is the enumeration the rule forbids,
 * reintroduced.
 */
export function agentApprovalVisibleTo(
  request: AgentApprovalRequest,
  principal: AgentPrincipal | null,
): boolean {
  return request.principalKey === agentApprovalPrincipalKey(principal)
}
