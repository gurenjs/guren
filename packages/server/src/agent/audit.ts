/**
 * The agent audit record (RFC 0016 §5.2): one invocation or one denial, in the
 * one shape a sink writes as a line and `guren tool:log` reads back.
 *
 * Declarations and pure derivation only. Nothing here opens a file or reads a
 * clock — {@link toAuditRecord} takes the instant as an argument — because
 * this module is reachable from every runtime the framework targets, including
 * the ones with no filesystem, and because a record builder that timestamped
 * itself could not be pinned by a test. *Where* records go is a sink's
 * decision, made once by the application (`@guren/plugin-mcp`'s `audit`
 * option); this module only says what one looks like.
 *
 * **Redaction is the emitter's contract, and nothing here may re-run it.**
 * `AgentToolInvoked.arguments` arrives having already been through
 * `redactAgentArguments`, exactly as `events.ts` states, and this module
 * carries it across verbatim. Masking again here would install a second,
 * quieter redaction rule beside the real one — the two would drift, and
 * nothing reading a record could tell which of them produced a mask it is
 * looking at. That is the reasoning `events.ts` used to refuse redacting on
 * construction, and it holds one layer down without change. A sink that wants
 * different masking changes the route's `.agent({ redact })`, which is the
 * one place the rule lives.
 */
import type { AgentPrincipal, AgentSurface, AgentToolDenialReason, AgentToolDenied, AgentToolInvoked } from './events'

/**
 * Where an application's audit trail is written by default, relative to the
 * app root. `storage/logs/` is the convention `LogManager`'s own examples
 * already use, so an audit trail lands beside the application log rather than
 * inventing a second place to look.
 */
export const DEFAULT_AGENT_AUDIT_PATH = 'storage/logs/agent-audit.log'

/** What every audit record carries, whatever its outcome. */
interface AgentAuditRecordBase {
  /** ISO 8601, in UTC — the instant the record was made. */
  ts: string
  surface: AgentSurface
  tool: string
  principal: AgentPrincipal | null
  /** Already redacted by the emitter; see the module header. */
  arguments: Record<string, unknown>
}

/**
 * A tool that ran. `status` and `durationMs` exist here and nowhere else:
 * a denial refuses before any HTTP happens, so there is no status it could
 * honestly report (RFC 0016 §5.2, as amended).
 */
export interface AgentAuditInvokedRecord extends AgentAuditRecordBase {
  outcome: 'invoked'
  status: number
  durationMs: number
}

/** A tool call the adapter refused before it reached the application. */
export interface AgentAuditDeniedRecord extends AgentAuditRecordBase {
  outcome: 'denied'
  reason: AgentToolDenialReason
}

/**
 * One line of the audit trail.
 *
 * A union rather than one interface with optional fields, so a record with a
 * `reason` *and* a `status` cannot be written down: the two outcomes disagree
 * about what happened, and a shape that admits both would let a sink emit that
 * contradiction and a reader believe it.
 */
export type AgentAuditRecord = AgentAuditInvokedRecord | AgentAuditDeniedRecord

/**
 * Every surface, as a value. Written as a total map of the union so that
 * adding a surface to {@link AgentSurface} fails to compile here rather than
 * making {@link parseAuditRecord} silently reject records from it.
 */
const AGENT_SURFACES: Record<AgentSurface, true> = {
  'mcp': true,
  'dev-mcp': true,
  'cli': true,
  'webmcp': true,
}

/** Every denial reason, as a value, total over the union for the same reason. */
const DENIAL_REASONS: Record<AgentToolDenialReason, true> = {
  'auth': true,
  'scope': true,
  'approval': true,
  'rate-limit': true,
}

/**
 * Derive the record for one audit event.
 *
 * `now` is a parameter rather than a `Date.now()` inside: the sink writing
 * this record also picks the dated file it lands in, and two clock reads can
 * disagree across a midnight boundary — a record stamped just before it,
 * filed just after. One read, used for both.
 *
 * The two events are told apart structurally, not with `instanceof`. The event
 * classes cross a package boundary that this repo resolves twice — `@guren/cli`
 * and the plugins reach `@guren/server` through its `dist`, a test inside
 * `packages/server` through `src` — so an `instanceof` here would answer
 * `false` for a genuine event constructed on the other side of that seam, and
 * would do it by mislabelling the record rather than by failing.
 */
export function toAuditRecord(event: AgentToolInvoked | AgentToolDenied, now: Date): AgentAuditRecord {
  const base = {
    ts: now.toISOString(),
    surface: event.surface,
    tool: event.tool,
    principal: event.principal,
    arguments: event.arguments,
  }

  return 'reason' in event
    ? { ...base, outcome: 'denied', reason: event.reason }
    : { ...base, outcome: 'invoked', status: event.status, durationMs: event.durationMs }
}

/**
 * Read one line of an audit file back, or `null` if it is not a record.
 *
 * The one parser on the read side. A caller that hand-rolled a second would be
 * the reader half of the drift this whole feature is built to avoid, and would
 * be the half that fails silently: a record it stops recognising reads as an
 * empty trail.
 *
 * Returning `null` rather than throwing is what makes the reader usable
 * against a file that is being appended to right now. The last line of such a
 * file is routinely a *partial* record — an append is not atomic — and a blank
 * line is what a file ends with. Neither is corruption, and neither should
 * take down a command whose whole job is to show what the earlier lines say.
 *
 * Extra keys are ignored, deliberately: the file sink writes through
 * `DailyFileChannel`, whose JSON format wraps the record in a log envelope
 * (`timestamp`, `level`, `message`). Tolerating that envelope is what lets the
 * sink reuse the channel's rotation and retention instead of reimplementing
 * both, and the record's own fields are unambiguous beside it.
 */
export function parseAuditRecord(line: string): AgentAuditRecord | null {
  if (line.trim() === '') return null

  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const candidate = parsed as Record<string, unknown>

  const ts = candidate.ts
  const tool = candidate.tool
  const surface = candidate.surface
  if (typeof ts !== 'string' || typeof tool !== 'string') return null
  if (typeof surface !== 'string' || !(surface in AGENT_SURFACES)) return null

  const base = {
    ts,
    tool,
    surface: surface as AgentSurface,
    principal: readPrincipal(candidate.principal),
    // A record whose arguments are missing or not an object says nothing about
    // what was passed; an empty record is the whole truth about it, and is the
    // same answer `redactAgentArguments` gives for the same input.
    arguments: isRecord(candidate.arguments) ? candidate.arguments : {},
  }

  if (candidate.outcome === 'invoked') {
    const { status, durationMs } = candidate
    if (typeof status !== 'number' || typeof durationMs !== 'number') return null
    return { ...base, outcome: 'invoked', status, durationMs }
  }

  if (candidate.outcome === 'denied') {
    const reason = candidate.reason
    if (typeof reason !== 'string' || !(reason in DENIAL_REASONS)) return null
    return { ...base, outcome: 'denied', reason: reason as AgentToolDenialReason }
  }

  return null
}

/**
 * The principal of a record, or `null`.
 *
 * An unreadable principal is `null` rather than a rejected record: who made a
 * call is the field most likely to change shape over the life of a log, and
 * losing the whole line — the tool, the arguments, the outcome — to recover
 * nothing is the wrong trade for an audit trail.
 */
function readPrincipal(value: unknown): AgentPrincipal | null {
  if (!isRecord(value)) return null

  const { kind, id, abilities } = value
  if (kind !== 'user' && kind !== 'service') return null
  if (typeof id !== 'string' && typeof id !== 'number') return null

  const principal: AgentPrincipal = { kind, id }
  if (Array.isArray(abilities)) {
    principal.abilities = abilities.filter((ability): ability is string => typeof ability === 'string')
  }
  return principal
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
