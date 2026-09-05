/**
 * `this.tools` (RFC 0017 §4): the one way an agent reaches its application.
 *
 * Every call enters the Part 1 pipeline with the agent's own principal, so the
 * gates and the redacted audit record are an MCP client's. The principal
 * arrives over the in-process seam, so `requireAuthenticated()` answers for it.
 *
 * Nothing here imports `agents`: this half runs on Bun, and the Durable Object
 * shell lives in `./agent`.
 */
import { createAgentApprovalContext, createAgentInvocationPipeline } from '@guren/core'
import type {
  AgentAuditEmitter,
  AgentInvocationDenial,
  AgentInvocationPipeline,
  AgentPrincipal,
  AgentToolDenialReason,
  ToolCallOutcome,
} from '@guren/core'

import { DEFAULT_AGENT_CALLS_PER_MINUTE } from './config'
import { findRegistrationByName, type AgentRuntime } from './latch'

/** The tool ran (or the application refused it) — `outcome` carries the answer. */
export interface AgentToolCallOk {
  ok: true
  outcome: ToolCallOutcome
  pending?: undefined
  denied?: undefined
  failed?: undefined
}

/**
 * The tool needs a human, and one has been asked.
 *
 * Nothing executed. Part 3 adds the ledger that checkpoints
 * `{ requestId, tool, args }` and retries once the approval settles; in this
 * part the agent gets the id and decides for itself what to do with it.
 */
export interface AgentToolCallPending {
  pending: true
  requestId: string
  tool: string
  expiresAt?: string
  message: string
  ok?: undefined
  denied?: undefined
  failed?: undefined
}

/** A gate refused before any HTTP happened. Nothing executed. */
export interface AgentToolCallDenied {
  denied: true
  reason: AgentToolDenialReason
  message: string
  ok?: undefined
  pending?: undefined
  failed?: undefined
}

/** The dispatch itself broke — not a response, a throw. */
export interface AgentToolCallFailed {
  failed: true
  message: string
  ok?: undefined
  pending?: undefined
  denied?: undefined
}

/**
 * One call's answer.
 *
 * Four variants with the other discriminants declared `?: undefined` so an
 * agent can write `if (result.pending) return` without narrowing first — the
 * shape RFC 0017 §5's example assumes.
 */
export type AgentToolCallResult =
  | AgentToolCallOk
  | AgentToolCallPending
  | AgentToolCallDenied
  | AgentToolCallFailed

export interface AgentToolClient {
  /** Call a tool by name. */
  call(name: string, args?: Record<string, unknown>): Promise<AgentToolCallResult>
  /**
   * Ask the route for a verdict instead of an execution (RFC 0016 §5.4).
   *
   * The scope gate runs and the budget is spent — a rehearsal dispatches a
   * request. The approval gate is skipped: rehearsing an approval-gated tool is
   * what a caller most needs, and a rehearsal executes nothing.
   */
  preflight(name: string, args?: Record<string, unknown>): Promise<AgentToolCallResult>
  /** The tool names this agent's registration expanded to, for diagnostics. */
  readonly allowed: readonly string[]
}

export interface AgentToolClientOptions {
  runtime: AgentRuntime
  /** The `config/agents.ts` key. */
  agentName: string
  /** The Durable Object instance name — `Agent.name` on the SDK side. */
  instanceId: string
  /** Injectable clock for the budget window, in milliseconds. Tests only. */
  now?: () => number
}

/**
 * Build the tool client for one agent instance.
 *
 * @throws When `agentName` names no registration — a wiring bug, not a scope
 *   denial, and a denial would send the author to the wrong file.
 */
export function createAgentToolClient(options: AgentToolClientOptions): AgentToolClient {
  const { runtime, agentName, instanceId } = options
  const registration = findRegistrationByName(runtime, agentName)
  if (!registration) {
    const known = [...runtime.registrations.values()].map((entry) => entry.name)
    throw new Error(
      `No agent named "${agentName}" is registered. `
      + (known.length > 0
        ? `config/agents.ts registers: ${known.join(', ')}.`
        : 'config/agents.ts registers no agents at all.'),
    )
  }

  // One array, both readers. The scope gate judges by `abilities` and the audit
  // record reports them, and a copy for one of the two is how a call comes to
  // be authorized under scopes the record does not show. It is frozen by
  // `freezeAgentRegistrations` before it ever reaches here.
  const abilities = registration.abilities

  const principal: AgentPrincipal = {
    kind: 'service',
    // Per instance, never per class: approvals are isolated by `kind + id`
    // (RFC 0017 §2). The instance half is encoded because it comes from the
    // Durable Object rather than a validated config — an unescaped `:` makes
    // `a:b`/`c` and `a`/`b:c` one principal. The name half is constrained by
    // `AGENT_NAME_PATTERN` instead, which keeps the common id readable.
    id: `agent:${agentName}:${encodeURIComponent(instanceId)}`,
    abilities: abilities as string[],
  }

  const budget = new SlidingWindowBudget(
    registration.budget?.callsPerMinute ?? DEFAULT_AGENT_CALLS_PER_MINUTE,
    options.now ?? (() => Date.now()),
  )

  // Per client, which is per instance, because the principal above is: an
  // approval is bound to who asked for it.
  const approvals = createAgentApprovalContext(runtime.approvals, principal)

  // Forwarded per event, not resolved here: the binding behind
  // `AgentRuntime.audit` is published by another plugin's `boot`, so an emitter
  // captured at construction is whatever the container held then. It memoizes.
  const resolveAudit = runtime.audit
  const audit: AgentAuditEmitter | undefined = resolveAudit
    ? (event) => resolveAudit()(event)
    : undefined

  const pipeline: AgentInvocationPipeline = createAgentInvocationPipeline({
    app: runtime.app,
    principal,
    abilities,
    surface: 'durable',
    ...(audit ? { audit } : {}),
    ...(approvals ? { approvals } : {}),
    approvalConfigureHint: 'agentsPlugin({ approvals: { store, notify } })',
    // The per-instance meter, at the pipeline's one seam — after the scope
    // gate, before the approval gate. That gate writes a record and pages a
    // human, and deduplicates only on identical arguments, so an unattended
    // loop varying one field would otherwise file unbounded requests.
    interpose: () => budget.consume(),
    // In-process: the request never crosses a socket, so there is no real Host
    // to carry. An app running host-authorization middleware has to admit this
    // origin — `guren tool:call` re-enters the same way and has the same
    // requirement.
    origin: 'http://localhost',
    // The principal is handed over the seam, never as a credential: nothing
    // issued an `ApiToken` here, and synthesizing one would mint a credential
    // the application never granted.
    handoff: 'seam',
  })

  const invoke = async (
    name: string,
    args: Record<string, unknown>,
    preflight: boolean,
  ): Promise<AgentToolCallResult> => {
    const tool = runtime.tools.find((candidate) => candidate.toolName === name)
    if (!tool) {
      // An agent author's bug, not a permission answer. A tool the *route
      // graph* has but this agent's scopes do not is a `denied` below, with
      // reason 'scope'; a name nothing in the application answers to is a
      // typo, and reporting it as a denial would send the reader to the wrong
      // file.
      throw new Error(
        `No tool named "${name}" exists in this application. `
        + `Tools this agent may call: ${abilities.length > 0 ? abilities.join(', ') : '(none)'}.`,
      )
    }

    const result = await pipeline.invoke({ tool, args, ...(preflight ? { preflight } : {}) })

    if (result.status === 'executed') return { ok: true, outcome: result.outcome }
    if (result.status === 'failed') return { failed: true, message: result.message }
    return fromDenial(result.denial, tool.toolName)
  }

  return {
    call: (name, args = {}) => invoke(name, args, false),
    preflight: (name, args = {}) => invoke(name, args, true),
    allowed: abilities.map((ability) => ability.slice('tool:'.length)),
  }
}

/**
 * Split a refusal into "waiting on a human" and "no".
 *
 * A pending request reaches the pipeline as a denial carrying
 * `body.status === 'pending'`; to an agent, which has a schedule, it is a
 * parked call. `rejected`, `spent` and "no queue" stay denials.
 */
function fromDenial(denial: AgentInvocationDenial, toolName: string): AgentToolCallResult {
  const body = denial.body
  if (denial.reason === 'approval' && body?.status === 'pending' && typeof body.requestId === 'string') {
    return {
      pending: true,
      requestId: body.requestId,
      tool: typeof body.tool === 'string' ? body.tool : toolName,
      ...(typeof body.expiresAt === 'string' ? { expiresAt: body.expiresAt } : {}),
      message: denial.message,
    }
  }
  return { denied: true, reason: denial.reason, message: denial.message }
}

/**
 * The per-instance meter.
 *
 * A sliding 60-second window held in the client instance, so an eviction resets
 * it: a floor on one instance's burst rate, not a global budget, which needs
 * the app's own rate-limit middleware. A preflight spends it too.
 */
class SlidingWindowBudget {
  private readonly hits: number[] = []

  constructor(
    private readonly limit: number,
    private readonly now: () => number,
  ) {}

  /** @returns a denial when the window is full, `undefined` when the call may proceed. */
  consume(): AgentInvocationDenial | undefined {
    const at = this.now()
    const cutoff = at - 60_000
    while (this.hits.length > 0 && this.hits[0] <= cutoff) {
      this.hits.shift()
    }
    // Bounded by `limit` once the config rule holds: nothing is pushed while
    // the window is full, so the array never exceeds it. That is why
    // `validateAgentsConfig` refuses a non-finite limit — `Infinity` would make
    // this branch unreachable and let `hits` grow without bound.
    if (this.hits.length >= this.limit) {
      return {
        reason: 'rate-limit',
        message:
          `This agent instance has already made ${this.limit} tool calls in the last minute, which is `
          + 'its budget. Nothing was executed. Raise it with `budget: { callsPerMinute }` in '
          + 'config/agents.ts, or space the calls out with a schedule.',
      }
    }
    this.hits.push(at)
    return undefined
  }
}
