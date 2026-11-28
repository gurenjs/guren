/**
 * The invocation pipeline (RFC 0017 §1): scope gate → interposition → confirmation
 * → approval gate → dispatch → redact → audit, in one protocol-neutral place. `app.fetch`
 * alone only executes, so a surface dispatching without these would bypass
 * scopes, approvals and the trail while looking exactly like a gated call.
 * One function with option hooks, not a middleware chain (RFC 0017 Open
 * Question 1): a chain would publish an ordering vocabulary, and the ordering
 * is the part that must not be negotiable. Nothing here imports an MCP type;
 * the result is a union each adapter maps onto its own shapes.
 */
import type { ExecutionContext } from 'hono'

import {
  agentApprovalFingerprints,
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
  agentApprovalKeysFromEnv,
  gateApproval,
  gatePreflight,
  gateToolCall,
  notifyApprovers,
  type ApprovalGateContext,
  type GateVerdict,
  type ScopeGateOptions,
} from './gate'
import type { Deferrer } from '../support/keep-alive'
import { redactAgentArguments } from './redact'
import { installAgentPrincipal, installAgentSharedProps, markAgentDispatch } from '../internal/agent-principal'

/**
 * What the audit hooks need from a tool: its name, and the redaction rules its
 * arguments are recorded under. Narrower than {@link DerivedAgentTool} because
 * one audited call has no route behind it: a `guren_preflight` invocation is
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
 * can drive it with a bare `fetch`. It must answer a rehearsal (the preflight
 * header) without running the route's action, as `Router` does: a target that
 * ignores the header runs a `confirm` tool's action before anyone is asked.
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
  /** Present when `reason` is `'confirmation'` and the call may be asked about. */
  confirmation?: AgentConfirmationRequest
}

/**
 * The question a `confirm` tool's call is held for (RFC 0042 §2.2). A surface that
 * can ask shows it, and repeats the call with {@link AgentInvocation.confirmed} set
 * to `fingerprint` once the caller agreed; every other surface refuses with the denial.
 */
export interface AgentConfirmationRequest {
  tool: string
  /** The route's message, else `Run "<toolName>"?`. */
  message: string
  /** The call's arguments after the tool's `redact` rules, for display. */
  input: Record<string, unknown>
  /** Of the raw arguments, under the current application key. */
  fingerprint: string
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
  /** True for a rehearsal (`guren_preflight`), which executes nothing. */
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
  /**
   * The shared Inertia props the dispatched request may carry (RFC 0038 §6),
   * installed on the request object so nothing on the wire can widen it.
   * Undefined leaves them all.
   */
  sharedProps?: readonly string[]
  /** Forwarded to `app.fetch` — D1/R2 bindings on Workers (RFC 0016 §3.1). */
  env?: unknown
  /** Forwarded to `app.fetch` — `waitUntil` on Workers. */
  executionCtx?: ExecutionContext
}

/**
 * Build {@link AgentInvocationOptions.approvals} for one caller — an approval binds
 * to the principal that asked; `undefined` means no queue. The TTL default, the
 * redaction rules and the `notify` wrapping are invariants of an approval record
 * rather than of a protocol, which is why `defer` arrives here: a `notify` the
 * pipeline received already wrapped cannot be given a deferrer afterwards.
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
  defer?: Deferrer,
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
    notify: notifyApprovers(config.notify, defer),
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
   * tool's own — see {@link AuditedTool}. `guren_preflight` is the one caller:
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
  /**
   * The {@link AgentConfirmationRequest.fingerprint} the caller agreed to. Set only
   * by a surface that asked: it is compared with this call's own arguments, so an
   * answer given for other arguments confirms nothing.
   */
  confirmed?: string
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

      const dispatch = async (rehearsal: boolean): Promise<ToolCallOutcome> => {
        const built = buildToolRequest(tool, args, {
          origin: options.origin,
          authorization: options.authorization,
          preflight: rehearsal,
          surface: options.surface,
        })
        if (!('request' in built)) {
          // No HTTP happened, but the call did: the status the app would have answered.
          return { content: [{ type: 'text', text: describeBuildFailure(built) }], isError: true, status: 400 }
        }

        // The dispatch mark and principal handoff, on the exact object about to
        // be dispatched. Both return the same object; assigning the result is
        // what keeps a future refactor from dispatching a copy.
        const request = markAgentDispatch(
          options.handoff === 'seam' && options.principal
            ? installAgentPrincipal(built.request, {
                principal: options.principal,
                abilities: options.abilities,
              })
            : built.request,
        )
        if (options.sharedProps) installAgentSharedProps(request, options.sharedProps)

        // env and execution context are forwarded explicitly — omitting them
        // silently loses D1/R2 bindings and waitUntil on Workers.
        return mapToolResponse(
          tool,
          await options.app.fetch(request, options.env, options.executionCtx),
          request.url,
        )
      }

      // One measurement around the whole round trip, the request build included.
      // `settle` decides what a dispatched outcome becomes; `undefined` records it as the result.
      const run = async (
        rehearsal: boolean,
        settle?: (outcome: ToolCallOutcome) => AgentInvocationResult | undefined,
      ): Promise<AgentInvocationResult> => {
        const startedAt = performance.now()
        try {
          const outcome = await dispatch(rehearsal)
          const settled = settle?.(outcome)
          if (settled) return settled
          record.invoked(audited, auditArgs, outcome.status, elapsed(startedAt))
          return { status: 'executed', outcome }
        } catch (error) {
          // The route's own failures came back as responses; reaching here means
          // the dispatch itself broke. Still an invocation — it ran — recorded
          // with the status the app would have reported for an unhandled throw.
          record.invoked(audited, auditArgs, 500, elapsed(startedAt))
          return { status: 'failed', message: error instanceof Error ? error.message : String(error) }
        }
      }

      // `gatePreflight` for a rehearsal: the same scope rule, minus the approval
      // half, for the reason `AgentInvocation.preflight` gives.
      const scope: GateVerdict = preflight
        ? gatePreflight(tool, options.abilities, scopeGateOptions)
        : gateToolCall(tool, options.abilities, scopeGateOptions)
      if (!scope.allowed) {
        return deny(toDenial(scope))
      }

      // The interposition seam, between scope and approval. See
      // `AgentInterposition` for why that position is not negotiable.
      if (options.interpose) {
        const interposed = await options.interpose({ tool, args, preflight })
        if (interposed) {
          return deny(interposed)
        }
      }

      // Confirmation (RFC 0042 §2.2), never for a rehearsal the caller asked for.
      // Ahead of approval: that gate writes a record and notifies people.
      if (!preflight && tool.confirm) {
        let fingerprint: string
        try {
          const keys = options.approvals?.keys ?? agentApprovalKeysFromEnv()
          fingerprint = (await agentApprovalFingerprints(args, keys))[0]!
        } catch (error) {
          // Fail closed: a call that cannot be fingerprinted cannot be matched to an answer.
          return deny({
            reason: 'confirmation',
            message:
              `The tool "${tool.toolName}" asks the calling user to confirm before it runs, and this call `
              + `could not be bound to an answer, so it was not run: ${error instanceof Error ? error.message : String(error)}`,
          })
        }

        if (call.confirmed !== fingerprint) {
          const { confirm } = tool
          // Rehearsed first, so a call the route's middleware or validation refuses is
          // answered with that refusal and no question reaches a person. Any other
          // answer is asked about, a middleware's own 200 included: returning it
          // would hand over a result the caller never agreed to fetch.
          return run(true, (rehearsal) => {
            if (rehearsal.status >= 400) return undefined
            return deny({
              reason: 'confirmation',
              message:
                `The tool "${tool.toolName}" asks the calling user to confirm before it runs, and this surface `
                + 'has no way to ask. Nothing was executed.',
              confirmation: {
                tool: tool.toolName,
                message: confirm.message ?? `Run "${tool.toolName}"?`,
                input: redactAgentArguments(args, tool.redact),
                fingerprint,
              },
            })
          })
        }
      }

      // Approval is never asked of a rehearsal.
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

      return run(preflight)
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
