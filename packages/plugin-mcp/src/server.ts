/**
 * Assembly of the per-request MCP server for the App MCP endpoint.
 *
 * The low-level `Server` is deliberate: the tools already carry JSON Schema
 * from `deriveAgentTools`, and the high-level `McpServer` API wants live Zod,
 * which would validate (and coerce/transform) a second time on top of the
 * route's own validation (RFC 0016 §3.2).
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
  gatePreflight,
  gateToolCall,
  isReservedAgentToolName,
  PREFLIGHT_TOOL_NAME,
  type AgentApprovalStore,
  type AgentInvocationDenial,
  type AgentInvocationPipeline,
  type AgentPrincipal,
  type AgentToolDenialReason,
  type AuditedTool,
  type DerivedAgentTool,
} from '@guren/core'

import {
  describeApprovalStatusTool,
  readApprovalStatusArguments,
  toApprovalStatusReport,
} from './approval-status'
import { describePreflightTool, readPreflightArguments, toPreflightVerdict } from './preflight'
import type { AgentRateLimiter } from './rate-limit'

export type { AuditedTool }

export interface AppMcpServerOptions {
  /** Tools already filtered to `expose.mcp`. */
  tools: readonly DerivedAgentTool[]
  /** The verified token's abilities — the scope grammar's input. */
  abilities: readonly string[]
  serverInfo: { name: string; version: string }
  /**
   * The pipeline every tool call and rehearsal runs through (RFC 0017 §1). This
   * module contributes the *MCP* half — which tools are listed, how a verdict
   * becomes a `CallToolResult` — and re-implements none of its steps, so a
   * refusal here cannot disagree with one elsewhere. Rate limiting reaches it
   * as the interposition hook, so its ordering is the pipeline's guarantee.
   */
  pipeline: AgentInvocationPipeline
  /**
   * Undefined disables rate limiting (config `rateLimit: false`). Consulted
   * here only for `guren.approval_status`, which reads the store rather than a
   * route and therefore never enters the pipeline; every other path is metered
   * by the pipeline's hook.
   */
  limiter?: AgentRateLimiter
  /** Rate-limit key — the token id, so budgets follow credentials, not IPs. */
  rateKey: string
  /**
   * The approval queue, when the application configured one (RFC 0016 §5.4
   * item 4). Absent, an `approval: 'required'` tool is refused fail-closed by
   * the pipeline and unlisted here. Narrower than the gate's own context: this
   * module only reports on records (`guren.approval_status`) and decides the
   * catalogue; creating them is configured on the pipeline, from one object.
   */
  approvals?: {
    store: AgentApprovalStore
    principal: AgentPrincipal | null
    now: () => Date
  }
  /**
   * Audit hooks for the one path that does not go through the pipeline —
   * `guren.approval_status`. The emitter owns redaction and event
   * construction; every other record on this surface is written by the
   * pipeline.
   */
  onInvoked(tool: AuditedTool, args: Record<string, unknown>, status: number, durationMs: number): void
  onDenied(tool: AuditedTool, args: Record<string, unknown>, reason: AgentToolDenialReason): void
}

/**
 * One server per request, stateless — `Server.connect()` binds a transport
 * once, so the endpoint constructs a fresh pair each time.
 */
export function createAppMcpServer(options: AppMcpServerOptions): Server {
  const server = new Server(options.serverInfo, { capabilities: { tools: {} } })

  // A route that claimed a reserved meta-tool name never reaches the catalog
  // (RFC 0016 §5.4). `guren check` fails the build over it, but the endpoint
  // must not depend on that: an MCP client answers a duplicated name in
  // `tools/list` by rejecting the whole list, so one collision costs the
  // entire catalogue. The plugin warns at boot naming the route.
  const tools = options.tools.filter((tool) => !isReservedAgentToolName(tool.toolName))

  const approvalsConfigured = options.approvals !== undefined

  // Listed only if `gateToolCall` would admit it: offering a tool the call then
  // refuses maps the write surface to a read-only token. With a queue an
  // approval-gated tool is callable (the call queues), so it stays listed; rate
  // limits are runtime state, not capability. Resolving approvals here would
  // page approvers on every connection, so only the synchronous gate runs.
  server.setRequestHandler(ListToolsRequestSchema, () => {
    const listed = tools
      .filter((tool) => gateToolCall(tool, options.abilities, { approvalsConfigured }).allowed)
      .map((tool) => describeTool(tool))

    // Listed only for a token that can check something: advertising the
    // companion to a token that grants nothing would map the existence of the
    // agent surface to a caller with no access to it. The condition is the
    // *scope* gate, not the catalog filter above.
    const preflightable = tools.some((tool) => gatePreflight(tool, options.abilities).allowed)
    if (!preflightable) return { tools: listed }

    // `guren.approval_status` rides that same condition — a token that can call
    // nothing has no request of its own to ask after — plus one: a server with
    // no queue holds no record any id could name, so advertising it there would
    // be the unconfigured queue looking like a working one. `preflightable` is
    // reused, not recomputed, so the two meta-tools cannot disagree.
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

    // Every check a call passes happens in there. What is left here is the
    // protocol: turning one of the pipeline's three results into the
    // `CallToolResult` shape an MCP client reads.
    const result = await options.pipeline.invoke({ tool, args })

    if (result.status === 'denied') return denial(result.denial)
    if (result.status === 'failed') return errorResult(result.message)

    const { outcome } = result
    const callResult: CallToolResult = { content: outcome.content }
    if (outcome.structuredContent) callResult.structuredContent = outcome.structuredContent
    if (outcome.isError) callResult.isError = true
    return callResult
  })

  return server
}

/**
 * `guren.preflight`: check whether a call to another tool would be allowed,
 * without performing it (RFC 0016 §5.4). Every check is the one a real call
 * would face, reached the same way and re-implemented nowhere, so a verdict
 * cannot disagree with the call it describes. A refusal is still a *successful*
 * answer; only an unanswerable question comes back as an error result.
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
    // Not a denial: naming a tool that does not exist is a mistake, and
    // `AgentToolDenied` would carry a tool name the audit trail invented.
    return errorResult(`Unknown tool "${request.name}".`)
  }

  // The meta-tool's identity with the checked tool's redaction rules, and
  // `auditedArguments` the outer `args`, so the record shows what the agent
  // asked; the redaction walk descends into `input`. Recording the *checked*
  // tool instead would make a refused rehearsal indistinguishable from a
  // refused write, and the probed tool already rides in `args.tool`.
  const result = await options.pipeline.invoke({
    tool: target,
    args: request.input,
    preflight: true,
    audited: { toolName: PREFLIGHT_TOOL_NAME, redact: target.redact },
    auditedArguments: args,
  })

  // Both refusals come back as error results carrying only the message: the
  // machine-readable bodies `denial()` renders on the call path come from the
  // approval gate, which a rehearsal skips by construction.
  if (result.status === 'denied') return errorResult(result.denial.message)
  if (result.status === 'failed') return errorResult(result.message)

  const mapped = toPreflightVerdict(target.toolName, result.outcome)
  if ('executed' in mapped) return errorResult(mapped.executed)

  return structuredResult(mapped.verdict)
}

/**
 * `guren.approval_status`: what became of one approval request (RFC 0016 §5.4
 * item 4). Audited under the meta-tool's own name with the status the answer
 * corresponds to: 200 for a report, 404 for a request this caller has none of.
 * The found/not-found distinction lives only in the trail — the caller is told
 * the same thing either way, which is why `toApprovalStatusReport` converges.
 */
async function handleApprovalStatus(
  options: AppMcpServerOptions,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const request = readApprovalStatusArguments(args)
  if ('error' in request) return errorResult(request.error)

  const approvals = options.approvals
  // Unreachable through the call path above; present so this function does not
  // depend on that check for its own soundness.
  if (!approvals) return errorResult('This server has no approval queue configured.')

  const audited: AuditedTool = { toolName: APPROVAL_STATUS_TOOL_NAME }

  if (options.limiter && !options.limiter.take(options.rateKey, { write: false })) {
    // Metered as a read: a status check reaches the application's storage, so
    // an unmetered one is a hole in the per-token budget an agent can poll
    // through.
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
      // and belongs to someone else. The caller must not be able to tell the
      // two apart, and the operator must.
      options.onInvoked(audited, args, outcome.foreign ? 403 : 404, elapsed(startedAt))
      return errorResult(outcome.notFound)
    }

    options.onInvoked(audited, args, 200, elapsed(startedAt))
    return structuredResult(outcome.report)
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
    // Only an object output schema is advertised: MCP requires
    // `outputSchema.type === 'object'`, and a non-object one would make the SDK
    // client reject the *entire* tools/list. A route whose `output` is
    // non-object still works — its results ride as text.
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
 * A meta-tool's successful answer in both halves: `structuredContent` because
 * `guren.preflight` and `guren.approval_status` advertise an output schema and
 * MCP requires a conforming one on success, and the same value as text beside
 * it for a client that ignores structured results.
 */
function structuredResult(value: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  }
}

/**
 * A pipeline refusal, carrying its machine-readable body beside the message.
 * An `isError: true` result reaches the SDK client with its `content` intact
 * even for a tool declaring an `outputSchema`, so a pending-approval requestId
 * can ride in the refusal (RFC 0016 §5.4). It is a second content block, not
 * `structuredContent`, which MCP defines for *successful* results.
 */
function denial({ message, body }: AgentInvocationDenial): CallToolResult {
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
