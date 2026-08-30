/**
 * The audit trail of the agent surface (RFC 0016 §5.2): every tool invocation
 * and every denial, as framework events, so an application forwards them
 * wherever it already forwards events instead of learning a second logging
 * API.
 *
 * Declarations only. Nothing here emits — the dispatch path does, once, at
 * the one place that knows the verdict — and nothing here redacts:
 * {@link AgentToolInvoked.arguments} is a *contract* that the emitter has
 * already run the arguments through `redactAgentArguments`. An event class
 * that redacted on construction would give a second, quieter redaction rule
 * beside the real one, and a listener has no way to tell a masked payload
 * from an unmasked one.
 */
import { Event } from '../events/Event'

/**
 * Who invoked a tool (RFC 0016 §4). `kind: 'service'` is an App MCP bearer
 * token with no `userId`; `'user'` is a session (WebMCP) or a user-owned
 * token. `abilities` are the token's, carried for the audit record — the
 * scope verdict itself was already taken by the dispatcher.
 */
export interface AgentPrincipal {
  kind: 'user' | 'service'
  id: string | number
  abilities?: string[]
}

/**
 * The protocol surface an invocation arrived on. `'mcp'` is the application's
 * own MCP endpoint, `'dev-mcp'` the development one, `'cli'` a
 * `guren tool:call`, `'webmcp'` an in-browser session-authenticated call.
 */
export type AgentSurface = 'mcp' | 'dev-mcp' | 'cli' | 'webmcp'

/**
 * Emitted when an agent tool invocation completed — successfully or not.
 * `status` carries the HTTP status the dispatch resolved to, so an error
 * response is one of these rather than a separate event; a call that never
 * reached the handler is an {@link AgentToolDenied} instead.
 */
export class AgentToolInvoked extends Event {
  /**
   * The invocation arguments **already redacted** by the emitter (see the
   * module header). Assigned in the body rather than declared as a
   * constructor parameter property: `arguments` is not a legal binding
   * identifier in strict mode, which every ES module is, though it is a
   * perfectly legal property name.
   */
  readonly arguments: Record<string, unknown>

  constructor(
    public readonly principal: AgentPrincipal | null,
    public readonly tool: string,
    redactedArguments: Record<string, unknown>,
    public readonly status: number,
    public readonly durationMs: number,
    public readonly surface: AgentSurface
  ) {
    super()
    this.arguments = redactedArguments
  }
}

/**
 * Why a tool invocation was refused before it reached the route handler.
 *
 * Deliberately no `'policy'`: `Gate` policies evaluate *inside* the
 * dispatched request, so a policy denial is an execution that returned 403 —
 * an {@link AgentToolInvoked} with that status — not an adapter-level
 * refusal. The reasons here are exactly the checks the adapter runs before
 * synthesizing the request, which is also why a denial carries no HTTP
 * status: no HTTP happened.
 */
export type AgentToolDenialReason = 'auth' | 'scope' | 'approval' | 'rate-limit'

/**
 * Emitted when an agent tool invocation was refused. Carries no status or
 * duration: nothing ran, and {@link AgentToolDenialReason} is the finding.
 * `'approval'` covers a tool declaring `approval: 'required'` whose call
 * became a pending record instead of an execution.
 */
export class AgentToolDenied extends Event {
  /** Redacted by the emitter, exactly as on {@link AgentToolInvoked}. */
  readonly arguments: Record<string, unknown>

  constructor(
    public readonly principal: AgentPrincipal | null,
    public readonly tool: string,
    redactedArguments: Record<string, unknown>,
    public readonly reason: AgentToolDenialReason,
    public readonly surface: AgentSurface
  ) {
    super()
    this.arguments = redactedArguments
  }
}
