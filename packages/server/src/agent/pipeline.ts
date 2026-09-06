/**
 * The invocation pipeline (RFC 0017 §1): scope gate → interposition → approval
 * gate → dispatch → redact → audit, in one protocol-neutral place. `app.fetch`
 * alone only executes, so a surface dispatching without these would bypass
 * scopes, approvals and the trail while looking exactly like a gated call.
 * One function with option hooks, not a middleware chain (RFC 0017 Open
 * Question 1): a chain would publish an ordering vocabulary, and the ordering
 * is the part that must not be negotiable. Nothing here imports an MCP type;
 * the result is a union each adapter maps onto its own shapes.
 */
import type { ExecutionContext } from 'hono'

import {
  DEFAULT_AGENT_APPROVAL_TTL_MS,
  type AgentApprovalRequest,
  type AgentApprovalStore,
} from './approval'
import type { AgentAuditEmitter } from './audit-emitter'
import type { DerivedAgentTool } from './derive'
import {
  buildToolRequest,
  describeBuildFailure,
  mapToolResponse,
  type ToolCallOutcome,
} from './dispatch'
import {
  AgentToolDenied,
  AgentToolInvoked,
  type AgentPrincipal,
  type AgentSurface,
  type AgentToolDenialReason,
} from './events'
import {
  gateApproval,
  gatePreflight,
  gateToolCall,
  notifyApprovers,
  type ApprovalGateContext,
  type GateVerdict,
  type ScopeGateOptions,
} from './gate'
import { redactAgentArguments } from './redact'
import { installAgentPrincipal } from '../internal/agent-principal'

/**
 * What the audit hooks need from a tool: its name, and the redaction rules its
 * arguments are recorded under. Narrower than {@link DerivedAgentTool} because
 * one audited call has no route behind it: a `guren.preflight` invocation is
 * recorded under the meta-tool's name with the *checked* tool's `redact` list,
 * the meta-tool's own being empty.
 */
export interface AuditedTool {
  toolName: string
  redact?: readonly string[]
}

/**
 * What the pipeline hands to `app.fetch`. Structural rather than
 * `Application`, so the pipeline stays a leaf of the agent layer and a test
 * can drive it with a bare `fetch`.
 */
export interface AgentDispatchTarget {
  fetch(request: Request, env?: unknown, executionCtx?: ExecutionContext): Promise<Response>
}

/** A refusal, in the one shape every surface renders. */
export interface AgentInvocationDenial {
  reason: AgentToolDenialReason
  message: string
  /**
   * A machine-readable body riding alongside the message. Only the approval
   * refusals carry one — a caller told "this is pending" needs the id to poll
   * with (see {@link GateVerdict}).
   */
  body?: Record<string, unknown>
}

/**
 * What one call through the pipeline came to. Three variants, because a
 * dispatch that *threw* is not one that answered: it is audited as an
 * invocation, but the caller has no response to map, only a message.
 * Collapsing it into `executed` would make every adapter invent an outcome,
 * and they would invent different ones.
 */
export type AgentInvocationResult =
  /** The request reached (or was refused by) the application. */
  | { status: 'executed'; outcome: ToolCallOutcome }
  /** A gate or the interposition hook refused before any HTTP happened. */
  | { status: 'denied'; denial: AgentInvocationDenial }
  /** The dispatch itself broke. Audited as a 500 invocation. */
  | { status: 'failed'; message: string }

/** The call the interposition hook is asked about. */
export interface InterposedAgentCall {
  tool: DerivedAgentTool
  args: Record<string, unknown>
  /** True for a rehearsal (`guren.preflight`), which executes nothing. */
  preflight: boolean
}

/**
 * The one seam a surface may put its own check in, **after the scope gate and
 * before the approval gate**: after scope so an unauthorized prober cannot
 * drain a budget on ungranted calls, before approval because that gate writes
 * a record and notifies humans, deduplicating only on *identical* arguments —
 * a caller varying one field files unbounded requests. A denial dispatches nothing.
 */
export type AgentInterposition = (
  call: InterposedAgentCall,
) => AgentInvocationDenial | undefined | Promise<AgentInvocationDenial | undefined>

/**
 * Everything the pipeline needs that is settled once per caller, not per call.
 */
export interface AgentInvocationOptions {
  /** The application the dispatched request re-enters. */
  app: AgentDispatchTarget
  /**
   * Who is calling. **Resolved by the caller**, never by the pipeline: how a
   * principal is established is the surface's business (a verified bearer, an
   * OAuth grant presented over a seam, a registered durable agent), and a
   * pipeline that guessed would be a second authentication rule.
   */
  principal: AgentPrincipal | null
  /** The scope grammar's input — the abilities the scope gate judges by. */
  abilities: readonly string[]
  /**
   * Which surface this is, for the audit trail. Caller-supplied and never
   * invented: the trail's whole value is that a record says where a call came
   * from, and a default would make the commonest surface absorb every one that
   * forgot to say.
   */
  surface: AgentSurface
  /**
   * Where invocations and denials are recorded. Undefined records nothing —
   * the call still works, exactly as an application with no audit sink
   * configured behaves today.
   */
  audit?: AgentAuditEmitter
  /**
   * The approval queue (RFC 0016 §5.4 item 4). Absent, a tool declaring
   * `approval: 'required'` is refused **fail-closed**: nothing is dispatched
   * and the denial is audited, so an unconfigured queue never looks like a
   * working one. `redact` takes the tool as well as the arguments, one context
   * serving every tool with each route's own masking rules.
   */
  approvals?: Omit<ApprovalGateContext, 'redact'> & {
    redact(tool: DerivedAgentTool, args: Record<string, unknown>): Record<string, unknown>
  }
  /**
   * How *this* surface configures an approval queue, named in the fail-closed
   * refusal. See {@link import('./gate').ScopeGateOptions.configureHint}.
   */
  approvalConfigureHint?: string
  /**
   * What a scope refusal calls the thing whose scopes fell short —
   * `"The token's scopes"` on a bearer surface. Defaults to the neutral
   * {@link DEFAULT_SCOPE_SUBJECT}, because a durable agent's principal is
   * minted from its registration and holds no token anyone could widen.
   */
  scopeSubject?: string
  /** The one interposition seam. See {@link AgentInterposition}. */
  interpose?: AgentInterposition
  /**
   * Origin the synthesized request is built on, so host-authorization
   * middleware sees the real Host the caller reached this surface on.
   */
  origin?: string
  /**
   * `Authorization` to forward verbatim, for a surface whose credential the
   * application's own guards can verify. **Mutually exclusive with
   * {@link handoff}, and enforced**: setting both puts two answers to "who is
   * this" on one request, which guard-resolution order would then settle
   * rather than anything the surface said, so the factory throws.
   */
  authorization?: string
  /**
   * `'seam'` installs {@link AgentInvocationOptions.principal} on the exact
   * `Request` handed to `app.fetch`, so `requireAuthenticated()`,
   * `Controller.auth` and `Gate` answer for it (RFC 0017 §2). Not a token:
   * `createBearerTokenMiddleware` and `tokenCan*` judge one and there is none,
   * so a route behind those refuses. Omitted, nothing is installed.
   */
  handoff?: 'seam'
  /** Forwarded to `app.fetch` — D1/R2 bindings on Workers (RFC 0016 §3.1). */
  env?: unknown
  /** Forwarded to `app.fetch` — `waitUntil` on Workers. */
  executionCtx?: ExecutionContext
}

/**
 * Build {@link AgentInvocationOptions.approvals} for one caller.
 *
 * The TTL default, the redaction rules and the `notify` wrapping are invariants
 * of an approval record rather than of a protocol. Per caller, because an
 * approval binds to the principal that asked; `undefined` means no queue.
 */
export function createAgentApprovalContext(
  config:
    | {
        store: AgentApprovalStore
        notify: (request: AgentApprovalRequest) => void | Promise<void>
        ttlMs?: number
      }
    | undefined,
  principal: AgentPrincipal | null,
): NonNullable<AgentInvocationOptions['approvals']> | undefined {
  if (!config) return undefined

  return {
    store: config.store,
    principal,
    now: () => new Date(),
    ttlMs: config.ttlMs ?? DEFAULT_AGENT_APPROVAL_TTL_MS,
    // The route's own masking rules, the same walk the audit trail uses. A
    // record a human reads and a store persists must not carry a field the
    // route declared must never be written down.
    redact: (tool, args) => redactAgentArguments(args, tool.redact),
    notify: notifyApprovers(config.notify),
  }
}

/** What {@link createAgentAuditRecorder} needs, settled once per caller. */
export interface AgentAuditRecorderOptions {
  audit?: AgentAuditEmitter
  principal: AgentPrincipal | null
  surface: AgentSurface
}

/** The two records a surface writes. See {@link createAgentAuditRecorder}. */
export interface AgentAuditRecorder {
  invoked(
    audited: AuditedTool,
    args: Record<string, unknown>,
    status: number,
    durationMs: number,
  ): void
  denied(
    audited: AuditedTool,
    args: Record<string, unknown>,
    reason: AgentToolDenialReason,
  ): void
}

/**
 * How a call is written down: principal, surface, and argument masking.
 *
 * Exported because a durable agent's approval-status check reaches the store
 * without dispatching a tool (RFC 0017 §5), and a second copy of this rule is
 * how one surface records an argument the other masks.
 */
export function createAgentAuditRecorder(options: AgentAuditRecorderOptions): AgentAuditRecorder {
  return {
    invoked(audited, args, status, durationMs): void {
      options.audit?.(
        new AgentToolInvoked(
          options.principal,
          audited.toolName,
          redactAgentArguments(args, audited.redact),
          status,
          durationMs,
          options.surface,
        ),
      )
    },
    denied(audited, args, reason): void {
      options.audit?.(
        new AgentToolDenied(
          options.principal,
          audited.toolName,
          redactAgentArguments(args, audited.redact),
          reason,
          options.surface,
        ),
      )
    },
  }
}

/** One call, as the pipeline is asked to run it. */
export interface AgentInvocation {
  /** The tool the request is built from. */
  tool: DerivedAgentTool
  /** The arguments the request is built from. */
  args: Record<string, unknown>
  /**
   * Ask the route for a verdict instead of an execution (RFC 0016 §5.4). The
   * scope half still runs — checking a tool requires the same scope as calling
   * it — but the **approval gate is skipped**: an approval-gated tool is the
   * one a caller most needs to rehearse, and a rehearsal executes nothing.
   */
  preflight?: boolean
  /**
   * The identity the record is written under, when it is not the dispatched
   * tool's own — see {@link AuditedTool}. `guren.preflight` is the one caller:
   * the meta-tool's name, the checked tool's redaction rules.
   */
  audited?: AuditedTool
  /**
   * The arguments written down, when they are not {@link args}. Separate
   * because the preflight path dispatches the *checked* tool's input while
   * recording the *meta-tool's* own arguments, so the record shows what the
   * agent actually asked. Collapsing the two silently changes what an audit
   * trail says a caller passed.
   */
  auditedArguments?: Record<string, unknown>
}

/** What {@link createAgentInvocationPipeline} returns. */
export interface AgentInvocationPipeline {
  invoke(call: AgentInvocation): Promise<AgentInvocationResult>
}

/**
 * Build the pipeline for one caller. A factory because everything in
 * {@link AgentInvocationOptions} is settled per caller and read per call — the
 * principal an approval binds to, the abilities the gate judges by, the surface
 * the trail records — and hoisting any of it would carry whichever caller
 * arrived first.
 */
export function createAgentInvocationPipeline(
  options: AgentInvocationOptions,
): AgentInvocationPipeline {
  // Refused at construction, not at the call: a surface that configured both
  // credentials has a wiring bug, and the honest moment to say so is when the
  // pipeline is built, before a single call has been dispatched under an
  // identity nobody decided. Silently preferring one would make the answer
  // depend on guard-resolution order.
  if (options.handoff === 'seam' && options.authorization !== undefined) {
    throw new Error(
      'createAgentInvocationPipeline: `authorization` and `handoff: \'seam\'` are mutually exclusive. '
      + 'A surface either presents a credential the application verifies, or hands over a principal the '
      + 'application trusts — never both.',
    )
  }

  // Settled once: both gate calls judge by the same scopes and speak to the
  // same caller, so a rehearsal and a real call cannot come to describe a
  // refusal differently.
  const scopeGateOptions: ScopeGateOptions = {
    approvalsConfigured: options.approvals !== undefined,
    ...(options.approvalConfigureHint !== undefined
      ? { configureHint: options.approvalConfigureHint }
      : {}),
    ...(options.scopeSubject !== undefined ? { scopeSubject: options.scopeSubject } : {}),
  }

  const record = createAgentAuditRecorder({
    ...(options.audit ? { audit: options.audit } : {}),
    principal: options.principal,
    surface: options.surface,
  })

  return {
    async invoke(call: AgentInvocation): Promise<AgentInvocationResult> {
      const { tool, args } = call
      const preflight = call.preflight === true
      const audited: AuditedTool = call.audited ?? tool
      const auditArgs = call.auditedArguments ?? args

      const deny = (denial: AgentInvocationDenial): AgentInvocationResult => {
        record.denied(audited, auditArgs, denial.reason)
        return { status: 'denied', denial }
      }

      // 1. Scope. `gatePreflight` for a rehearsal — the same scope rule, minus
      //    the approval half, for the reason `AgentInvocation.preflight` gives.
      const scope: GateVerdict = preflight
        ? gatePreflight(tool, options.abilities, scopeGateOptions)
        : gateToolCall(tool, options.abilities, scopeGateOptions)
      if (!scope.allowed) {
        return deny(toDenial(scope))
      }

      // 2. The interposition seam, between scope and approval. See
      //    `AgentInterposition` for why that position is not negotiable.
      if (options.interpose) {
        const interposed = await options.interpose({ tool, args, preflight })
        if (interposed) {
          return deny(interposed)
        }
      }

      // 3. Approval — never for a rehearsal.
      if (!preflight && tool.approval === 'required' && options.approvals) {
        const { approvals } = options
        let verdict: GateVerdict
        try {
          verdict = await gateApproval(tool, args, {
            ...approvals,
            redact: (callArgs) => approvals.redact(tool, callArgs),
          })
        } catch (error) {
          // The store threw, or the arguments could not be fingerprinted.
          // Fail closed, naming which half broke: a gate that fell open on a
          // storage error would run exactly the class of tool it exists to
          // hold back, on a day the database is already having a bad time.
          return deny({
            reason: 'approval',
            message:
              `The approval queue could not be reached, so "${tool.toolName}" was not run and no request `
              + `was recorded: ${error instanceof Error ? error.message : String(error)}`,
          })
        }
        if (!verdict.allowed) {
          return deny(toDenial(verdict))
        }
      }

      // 4. Dispatch, then redact and audit — one measurement around the whole
      //    round trip, including the request build.
      const startedAt = performance.now()
      try {
        const built = buildToolRequest(tool, args, {
          origin: options.origin,
          authorization: options.authorization,
          preflight,
          surface: options.surface,
        })
        if (!('request' in built)) {
          // No HTTP happened, but the call did — recorded as an invocation
          // with the status the app would have answered.
          const outcome: ToolCallOutcome = {
            content: [{ type: 'text', text: describeBuildFailure(built) }],
            isError: true,
            status: 400,
          }
          record.invoked(audited, auditArgs, outcome.status, elapsed(startedAt))
          return { status: 'executed', outcome }
        }

        // The principal handoff, on the exact object about to be dispatched.
        // `installAgentPrincipal` returns the same object; assigning its
        // result is what keeps a future refactor from dispatching a copy.
        const request =
          options.handoff === 'seam' && options.principal
            ? installAgentPrincipal(built.request, {
                principal: options.principal,
                abilities: options.abilities,
              })
            : built.request

        // env and execution context are forwarded explicitly — omitting them
        // silently loses D1/R2 bindings and waitUntil on Workers.
        const outcome = await mapToolResponse(
          tool,
          await options.app.fetch(request, options.env, options.executionCtx),
        )
        record.invoked(audited, auditArgs, outcome.status, elapsed(startedAt))
        return { status: 'executed', outcome }
      } catch (error) {
        // The route's own failures came back as responses; reaching here means
        // the dispatch itself broke. Still an invocation — it ran — recorded
        // with the status the app would have reported for an unhandled throw.
        record.invoked(audited, auditArgs, 500, elapsed(startedAt))
        return { status: 'failed', message: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

/**
 * A refused gate verdict, in the one shape every surface renders.
 *
 * `body` is spread conditionally rather than assigned: `body: verdict.body`
 * leaves the key present holding `undefined`, which is not the same object
 * under strict comparison or serialization as one that never carried a body.
 */
function toDenial(verdict: Extract<GateVerdict, { allowed: false }>): AgentInvocationDenial {
  return {
    reason: verdict.reason,
    message: verdict.message,
    ...(verdict.body ? { body: verdict.body } : {}),
  }
}

function elapsed(startedAt: number): number {
  return Math.round(performance.now() - startedAt)
}
