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

import { gateToolCall } from './gate'
import { advertisesStructuredOutput, type ToolCallOutcome } from '@guren/core'
import type { AgentRateLimiter } from './rate-limit'

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
  /** Execute one granted call. Errors it throws become error results, not protocol faults. */
  dispatch(tool: DerivedAgentTool, args: Record<string, unknown>): Promise<ToolCallOutcome>
  /** Audit hooks — the emitter owns redaction and event construction. */
  onInvoked(tool: DerivedAgentTool, args: Record<string, unknown>, status: number, durationMs: number): void
  onDenied(tool: DerivedAgentTool, args: Record<string, unknown>, reason: AgentToolDenialReason): void
}

/**
 * One server per request, stateless — `Server.connect()` binds a transport
 * once, so the endpoint constructs a fresh pair each time (the same pattern
 * as the Dev MCP endpoint).
 */
export function createAppMcpServer(options: AppMcpServerOptions): Server {
  const server = new Server(options.serverInfo, { capabilities: { tools: {} } })

  // The catalog a token sees is the catalog it can call: a tool is listed
  // only if `gateToolCall` would admit it, so scope *and* the current
  // approval verdict decide both. Listing a tool a call then refuses (an
  // ungranted one maps the write surface for a read-only token; an
  // approval-required one with no queue is categorically uncallable today)
  // makes the list lie, and MCP clients treat it as an invitation. Rate
  // limits are deliberately not consulted — a budget is a runtime state, not
  // a capability, and a temporarily-throttled tool is still in the catalog.
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: options.tools
      .filter((tool) => gateToolCall(tool, options.abilities).allowed)
      .map((tool) => describeTool(tool)),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const name = request.params.name
    const args = (request.params.arguments ?? {}) as Record<string, unknown>

    const tool = options.tools.find((candidate) => candidate.toolName === name)
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
