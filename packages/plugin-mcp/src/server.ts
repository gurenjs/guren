/**
 * Assembly of the per-request MCP server for the App MCP endpoint.
 *
 * The low-level `Server` is deliberate: the tools already carry JSON Schema
 * from `deriveAgentTools`, and the high-level `McpServer` API wants live Zod
 * — which would validate (and `coerce`/`transform`) a second time on top of
 * the route's own validation (RFC 0016 §3.2). Structural validation is the
 * client's job against the advertised schema; semantic validation is the
 * route's.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js'
import {
  advertisesStructuredOutput,
  APPROVAL_STATUS_TOOL_NAME,
  isReservedAgentToolName,
  PREFLIGHT_TOOL_NAME,
  type AgentToolDenialReason,
  type DerivedAgentTool,
  type ToolCallOutcome,
} from '@guren/core'

import {
  describeApprovalStatusTool,
  readApprovalStatusArguments,
  toApprovalStatusReport,
} from './approval-status'
import {
  gateApproval,
  gatePreflight,
  gateToolCall,
  type ApprovalGateContext,
  type GateVerdict,
} from './gate'
import { describePreflightTool, readPreflightArguments, toPreflightVerdict } from './preflight'
import type { AgentRateLimiter } from './rate-limit'

/**
 * What the audit hooks need from a tool: its name, and the redaction rules
 * its arguments are recorded under.
 *
 * Narrower than `DerivedAgentTool` because one audited call has no route
 * behind it. A `guren.preflight` invocation is recorded under the meta-tool's
 * name but with the *checked* tool's `redact` list, because the arguments
 * being written down are that tool's — recording them under the meta-tool's
 * (empty) list would publish to the audit trail exactly the fields a route
 * declared must never be written down.
 */
export interface AuditedTool {
  toolName: string
  redact?: readonly string[]
}

export interface AppMcpServerOptions {
  /** Tools already filtered to `expose.mcp`. */
  tools: readonly DerivedAgentTool[]
  /** The verified token's abilities — the scope grammar's input. */
  abilities: readonly string[]
  serverInfo: { name: string; version: string }
  /** Undefined disables rate limiting (config `rateLimit: false`). */
  limiter?: AgentRateLimiter
  /** Rate-limit key — the token id, so budgets follow credentials, not IPs. */
  rateKey: string
  /**
   * Execute one granted call. Errors it throws become error results, not
   * protocol faults. `preflight` asks the route for a verdict instead of an
   * execution — the request runs the middleware chain and validates the
   * advertised contract, then stops before the handler (RFC 0016 §5.4).
   */
  dispatch(
    tool: DerivedAgentTool,
    args: Record<string, unknown>,
    options?: { preflight?: boolean },
  ): Promise<ToolCallOutcome>
  /**
   * The approval queue, when the application configured one (RFC 0016 §5.4
   * item 4). Absent, an `approval: 'required'` tool is refused fail-closed and
   * is absent from the catalogue — an unconfigured queue must never look like
   * a working one.
   *
   * `redact` takes the tool as well as the arguments: the record a human reads
   * carries the *route's* masking rules, and this one context serves every
   * tool. The gate is handed a bound copy per call.
   */
  approvals?: Omit<ApprovalGateContext, 'redact'> & {
    redact(tool: DerivedAgentTool, args: Record<string, unknown>): Record<string, unknown>
  }
  /** Audit hooks — the emitter owns redaction and event construction. */
  onInvoked(tool: AuditedTool, args: Record<string, unknown>, status: number, durationMs: number): void
  onDenied(tool: AuditedTool, args: Record<string, unknown>, reason: AgentToolDenialReason): void
}

/**
 * One server per request, stateless — `Server.connect()` binds a transport
 * once, so the endpoint constructs a fresh pair each time (the same pattern
 * as the Dev MCP endpoint).
 */
export function createAppMcpServer(options: AppMcpServerOptions): Server {
  const server = new Server(options.serverInfo, { capabilities: { tools: {} } })

  // A route that claimed a reserved meta-tool name never reaches the catalog
  // (RFC 0016 §5.4). `guren check` fails the build over it, but the endpoint
  // must not depend on a check having been run: two tools with one name in
  // `tools/list` is not a two-tool problem, it is one an MCP client answers
  // by rejecting the whole list — so the collision would cost the entire
  // catalogue. The plugin warns at boot naming the route.
  const tools = options.tools.filter((tool) => !isReservedAgentToolName(tool.toolName))

  const approvalsConfigured = options.approvals !== undefined

  // The catalog a token sees is the catalog it can call: a tool is listed
  // only if `gateToolCall` would admit it, so scope *and* the current
  // approval verdict decide both. Listing a tool a call then refuses (an
  // ungranted one maps the write surface for a read-only token; an
  // approval-required one on a server with no queue is categorically
  // uncallable) makes the list lie, and MCP clients treat it as an invitation.
  // With a queue, such a tool *is* callable — the call becomes a pending
  // request, which is the interaction the queue exists to offer — so it is
  // listed. Rate limits are deliberately not consulted: a budget is a runtime
  // state, not a capability, and a temporarily-throttled tool is still in the
  // catalog.
  //
  // `gateToolCall` is synchronous and writes nothing, which is what makes it
  // safe to run per tool per listing. The approval *resolution* — the half
  // that creates a pending record and notifies approvers — is `gateApproval`,
  // reached only from the call path below. A listing that resolved approvals
  // would file a request and page the approvers once per gated tool, every
  // time any client connected.
  server.setRequestHandler(ListToolsRequestSchema, () => {
    const listed = tools
      .filter((tool) => gateToolCall(tool, options.abilities, { approvalsConfigured }).allowed)
      .map((tool) => describeTool(tool))

    // `guren.preflight` is listed only for a token that can check something.
    // A token granting nothing has nothing to rehearse, and advertising the
    // companion to it would map the existence of the agent surface to a
    // caller with no access to it.
    //
    // The condition is the *scope* gate, not the catalog filter above. On a
    // server with no queue an approval-gated tool is missing from the list
    // precisely because it cannot be called, which is the case where asking
    // "would this be allowed" is worth the most; with a queue it is listed,
    // and rehearsing it before spending an approver's attention on it is
    // worth about as much.
    const preflightable = tools.some((tool) => gatePreflight(tool, options.abilities).allowed)
    if (!preflightable) return { tools: listed }

    // `guren.approval_status` rides that same condition — a token that can
    // call nothing has no request of its own to ask after — and one more: a
    // server with no queue holds no record any id could name, so the tool
    // could only ever answer "no such request". Advertising it there would be
    // the unconfigured queue looking like a working one, which is what the
    // fail-closed refusal exists to prevent. The `preflightable` value is
    // reused rather than recomputed, so the two meta-tools cannot come to
    // disagree about what a token grants.
    return {
      tools: approvalsConfigured
        ? [...listed, describePreflightTool(), describeApprovalStatusTool()]
        : [...listed, describePreflightTool()],
    }
  })

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const name = request.params.name
    const args = (request.params.arguments ?? {}) as Record<string, unknown>

    if (name === PREFLIGHT_TOOL_NAME) {
      return handlePreflight(options, tools, args)
    }

    // Only when a queue exists, matching what `tools/list` advertised. On a
    // server without one the name falls through to the unknown-tool answer,
    // which is what a caller that never saw it listed should be told.
    if (name === APPROVAL_STATUS_TOOL_NAME && approvalsConfigured) {
      return handleApprovalStatus(options, args)
    }

    const tool = tools.find((candidate) => candidate.toolName === name)
    if (!tool) {
      return errorResult(`Unknown tool "${name}".`)
    }

    const verdict = gateToolCall(tool, options.abilities, { approvalsConfigured })
    if (!verdict.allowed) {
      options.onDenied(tool, args, verdict.reason)
      return refusal(verdict.message, verdict.body)
    }

    // Metered before the approval gate, not after. That gate writes a record
    // and pages a human, and it deduplicates only on *identical* arguments, so
    // a caller varying one field (`{id: 1}`, `{id: 2}`, …) files an unbounded
    // number of requests and sends an unbounded number of notifications. An
    // unmetered path that reaches the store is a hole in the per-token budget —
    // the reason `guren.preflight` and `guren.approval_status` both meter
    // first — and this is the one that additionally sends mail, so it is the
    // last place the exemption belongs. A write tool spends the write budget
    // whether it executes or queues: what is being limited is the request.
    if (options.limiter && !options.limiter.take(options.rateKey, { write: !tool.annotations.readOnlyHint })) {
      options.onDenied(tool, args, 'rate-limit')
      return errorResult(
        `Rate limit exceeded for this token${tool.annotations.readOnlyHint ? '' : ' (write budget)'}. Retry later.`,
      )
    }

    if (tool.approval === 'required' && options.approvals) {
      const { approvals } = options
      let approval: GateVerdict
      try {
        approval = await gateApproval(tool, args, {
          ...approvals,
          redact: (callArgs) => approvals.redact(tool, callArgs),
        })
      } catch (error) {
        // The queue itself failed: the store threw, or the arguments could not
        // be fingerprinted. Fail closed, and say which half broke. An approval
        // gate that fell open on a storage error would execute exactly the
        // class of tool the whole feature exists to hold back, and it would do
        // it on the day the database was already having a bad time.
        options.onDenied(tool, args, 'approval')
        return errorResult(
          `The approval queue could not be reached, so "${tool.toolName}" was not run and no request `
          + `was recorded: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      if (!approval.allowed) {
        options.onDenied(tool, args, approval.reason)
        return refusal(approval.message, approval.body)
      }
    }

    const startedAt = performance.now()
    try {
      const outcome = await options.dispatch(tool, args)
      options.onInvoked(tool, args, outcome.status, elapsed(startedAt))
      const result: CallToolResult = { content: outcome.content }
      if (outcome.structuredContent) result.structuredContent = outcome.structuredContent
      if (outcome.isError) result.isError = true
      return result
    } catch (error) {
      // The route's own failures came back as responses; reaching here means
      // the dispatch itself broke. Still an invocation — it ran — recorded
      // with the status the app would have reported for an unhandled throw.
      options.onInvoked(tool, args, 500, elapsed(startedAt))
      return errorResult(error instanceof Error ? error.message : String(error))
    }
  })

  return server
}

/**
 * `guren.preflight`: check whether a call to another tool would be allowed,
 * without performing it (RFC 0016 §5.4).
 *
 * Every check is the one a real call would face, reached the same way — the
 * scope gate here, then the route's own middleware and contract validation
 * inside the dispatched request, which stops at the seam mounted last before
 * the handler. Nothing in this function re-implements any of them, which is
 * what keeps a verdict from disagreeing with the call it describes.
 *
 * A refusal is still a *successful* answer: the caller asked whether the call
 * would be allowed, and "no, here is why" answers it. Only a question that
 * could not be answered at all — an unusable argument, an unknown tool, a
 * scope that does not admit the check — comes back as an error result.
 */
async function handlePreflight(
  options: AppMcpServerOptions,
  tools: readonly DerivedAgentTool[],
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const request = readPreflightArguments(args)
  if ('error' in request) return errorResult(request.error)

  const target = tools.find((candidate) => candidate.toolName === request.name)
  if (!target) {
    // Not a denial: naming a tool that does not exist is a mistake, not an
    // attempt at something forbidden, and `AgentToolDenied` carries a tool
    // name the audit trail would be inventing.
    return errorResult(`Unknown tool "${request.name}".`)
  }

  // The meta-tool's identity, the checked tool's redaction rules — see
  // `AuditedTool`. `args` rather than `request.input`, so the record shows
  // what the agent actually asked; the redaction walk descends into `input`.
  const audited: AuditedTool = { toolName: PREFLIGHT_TOOL_NAME, redact: target.redact }

  const verdict = gatePreflight(target, options.abilities)
  if (!verdict.allowed) {
    // Recorded as a `guren.preflight` call, like every other outcome of this
    // handler. Naming the *checked* tool reads better in isolation — it says
    // which tool was probed — but it makes a refused rehearsal
    // indistinguishable from a refused real call to a mutating tool, and of
    // the two things an operator can be told wrongly, that is the worse one.
    // Nothing is lost: the probed tool rides in `args.tool`.
    options.onDenied(audited, args, verdict.reason)
    return errorResult(verdict.message)
  }

  if (options.limiter && !options.limiter.take(options.rateKey, { write: false })) {
    // Metered as a read: a preflight executes nothing, but it does re-enter
    // the application with a real request, and an unmetered channel that does
    // that is a hole in the per-token budget.
    options.onDenied(audited, args, 'rate-limit')
    return errorResult('Rate limit exceeded for this token. Retry later.')
  }

  const startedAt = performance.now()
  try {
    const outcome = await options.dispatch(target, request.input, { preflight: true })
    options.onInvoked(audited, args, outcome.status, elapsed(startedAt))

    const mapped = toPreflightVerdict(target.toolName, outcome)
    if ('executed' in mapped) return errorResult(mapped.executed)

    // Both halves: `structuredContent` because the tool advertises an output
    // schema and MCP requires a conforming one on success, and the text
    // content beside it because a client that ignores structured results
    // still has to be able to read the verdict.
    return {
      content: [{ type: 'text', text: JSON.stringify(mapped.verdict) }],
      structuredContent: mapped.verdict,
    }
  } catch (error) {
    options.onInvoked(audited, args, 500, elapsed(startedAt))
    return errorResult(error instanceof Error ? error.message : String(error))
  }
}

/**
 * `guren.approval_status`: what became of one approval request (RFC 0016 §5.4
 * item 4).
 *
 * Audited as an ordinary invocation under the meta-tool's own name — an agent
 * asking after a request is something an operator wants in the trail — with
 * the status the answer corresponds to: 200 for a report, 404 for a request
 * this caller has none of. The trail is where the found/not-found distinction
 * is allowed to live; the *caller* is told the same thing either way, which is
 * why `toApprovalStatusReport` converges both on one branch rather than
 * leaving two call sites to agree.
 *
 * No redaction list is passed: the only argument is a request id the caller
 * supplied, and the built-in fragments still apply through the emitter.
 */
async function handleApprovalStatus(
  options: AppMcpServerOptions,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const request = readApprovalStatusArguments(args)
  if ('error' in request) return errorResult(request.error)

  const approvals = options.approvals
  // Unreachable through the call path above, which checks the same thing;
  // present because this function must not depend on that check for its own
  // soundness.
  if (!approvals) return errorResult('This server has no approval queue configured.')

  const audited: AuditedTool = { toolName: APPROVAL_STATUS_TOOL_NAME }

  if (options.limiter && !options.limiter.take(options.rateKey, { write: false })) {
    // Metered as a read, like preflight and for the neighbouring reason: a
    // status check reaches the application's own storage through the store, so
    // an unmetered one is a hole in the per-token budget that an agent can
    // poll through. The cost is that a throttled caller cannot learn its
    // request landed, which the pending refusal already told it.
    options.onDenied(audited, args, 'rate-limit')
    return errorResult('Rate limit exceeded for this token. Retry later.')
  }

  const startedAt = performance.now()
  try {
    const record = await approvals.store.find(request.requestId)
    const outcome = toApprovalStatusReport(
      request.requestId,
      record,
      approvals.principal,
      approvals.now(),
    )

    if ('notFound' in outcome) {
      // 404 to the caller either way; 403 in the trail when the record exists
      // and belongs to someone else. That asymmetry is the point — the caller
      // must not be able to tell the two apart, and the operator must. A
      // caller walking ids to find other principals' pending actions is
      // otherwise a run of ordinary not-founds.
      options.onInvoked(audited, args, outcome.foreign ? 403 : 404, elapsed(startedAt))
      return errorResult(outcome.notFound)
    }

    options.onInvoked(audited, args, 200, elapsed(startedAt))
    // Both halves, as `guren.preflight` returns: `structuredContent` because
    // the tool advertises an output schema and MCP requires a conforming one
    // on success, and the text beside it for a client that reads only content.
    return {
      content: [{ type: 'text', text: JSON.stringify(outcome.report) }],
      structuredContent: outcome.report,
    }
  } catch (error) {
    options.onInvoked(audited, args, 500, elapsed(startedAt))
    return errorResult(error instanceof Error ? error.message : String(error))
  }
}

function describeTool(tool: DerivedAgentTool) {
  return {
    name: tool.toolName,
    ...(tool.description ? { description: tool.description } : {}),
    inputSchema: tool.inputSchema as { type: 'object'; [key: string]: unknown },
    // Only an object output schema is advertised: MCP requires
    // `outputSchema.type === 'object'`, and a single array/primitive one
    // would make the SDK client reject the *entire* tools/list. A route
    // whose `output` is non-object still works — its results ride as text,
    // the same branch `advertisesStructuredOutput` gates on the response
    // side, so list and call stay in agreement.
    ...(advertisesStructuredOutput(tool)
      ? { outputSchema: tool.outputSchema as { type: 'object'; [key: string]: unknown } }
      : {}),
    annotations: {
      readOnlyHint: tool.annotations.readOnlyHint,
      destructiveHint: tool.annotations.destructiveHint,
      idempotentHint: tool.annotations.idempotentHint,
    },
  }
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

/**
 * A refusal, carrying the gate's machine-readable body beside the message when
 * it has one.
 *
 * An `isError: true` result reaches the client with its `content` intact —
 * measured against the SDK client, including for a tool that declares an
 * `outputSchema`, where neither a `-32600` nor structured-content validation
 * intervenes. That measurement is what makes a pending-approval answer
 * expressible at all on this protocol: the requestId an agent has to poll with
 * rides in the refusal itself (RFC 0016 §5.4).
 *
 * It rides as a second content block rather than as `structuredContent`, which
 * MCP defines for *successful* results — a refusal carrying one would be
 * claiming a shape of success the tool's own `outputSchema` does not describe.
 */
function refusal(message: string, body?: Record<string, unknown>): CallToolResult {
  if (!body) return errorResult(message)
  return {
    content: [
      { type: 'text', text: message },
      { type: 'text', text: JSON.stringify(body) },
    ],
    isError: true,
  }
}

function elapsed(startedAt: number): number {
  return Math.round(performance.now() - startedAt)
}
