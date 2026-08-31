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
import type { AgentToolDenialReason, DerivedAgentTool } from '@guren/core'

import { gatePreflight, gateToolCall } from './gate'
import {
  advertisesStructuredOutput,
  isReservedAgentToolName,
  PREFLIGHT_TOOL_NAME,
  type ToolCallOutcome,
} from '@guren/core'
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

  // The catalog a token sees is the catalog it can call: a tool is listed
  // only if `gateToolCall` would admit it, so scope *and* the current
  // approval verdict decide both. Listing a tool a call then refuses (an
  // ungranted one maps the write surface for a read-only token; an
  // approval-required one with no queue is categorically uncallable today)
  // makes the list lie, and MCP clients treat it as an invitation. Rate
  // limits are deliberately not consulted — a budget is a runtime state, not
  // a capability, and a temporarily-throttled tool is still in the catalog.
  server.setRequestHandler(ListToolsRequestSchema, () => {
    const listed: ReturnType<typeof describeTool>[] = tools
      .filter((tool) => gateToolCall(tool, options.abilities).allowed)
      .map((tool) => describeTool(tool))

    // `guren.preflight` is listed only for a token that can check something.
    // A token granting nothing has nothing to rehearse, and advertising the
    // companion to it would map the existence of the agent surface to a
    // caller with no access to it.
    //
    // The condition is the *scope* gate, not the catalog filter above: an
    // approval-gated tool is missing from the list precisely because it
    // cannot be called, which is the case where asking "would this be
    // allowed" is worth the most.
    const preflightable = tools.some((tool) => gatePreflight(tool, options.abilities).allowed)

    return { tools: preflightable ? [...listed, describePreflightTool()] : listed }
  })

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const name = request.params.name
    const args = (request.params.arguments ?? {}) as Record<string, unknown>

    if (name === PREFLIGHT_TOOL_NAME) {
      return handlePreflight(options, tools, args)
    }

    const tool = tools.find((candidate) => candidate.toolName === name)
    if (!tool) {
      return errorResult(`Unknown tool "${name}".`)
    }

    const verdict = gateToolCall(tool, options.abilities)
    if (!verdict.allowed) {
      options.onDenied(tool, args, verdict.reason)
      return errorResult(verdict.message)
    }

    if (options.limiter && !options.limiter.take(options.rateKey, { write: !tool.annotations.readOnlyHint })) {
      options.onDenied(tool, args, 'rate-limit')
      return errorResult(
        `Rate limit exceeded for this token${tool.annotations.readOnlyHint ? '' : ' (write budget)'}. Retry later.`,
      )
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

function elapsed(startedAt: number): number {
  return Math.round(performance.now() - startedAt)
}
