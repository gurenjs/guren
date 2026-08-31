import {
  AgentToolDenied,
  AgentToolInvoked,
  DEFAULT_AGENT_AUDIT_PATH,
  buildToolRequest,
  definePlugin,
  deriveAgentTools,
  mapToolResponse,
  readBearerToken,
  redactAgentArguments,
  verifyApiToken,
  type AgentAuditRecord,
  type AgentPrincipal,
  type AgentToolDenialReason,
  type Application,
  type AuthManager,
  type DerivedAgentTool,
  type EventManager,
  type ServiceProviderConstructor,
  type ToolCallOutcome,
} from '@guren/core'
import type { Context } from 'hono'

import { createAuditEmitter, type AgentAuditSink } from './audit-emitter'
import { AgentRateLimiter, type RateLimitConfig } from './rate-limit'
import { createAppMcpServer } from './server'

export interface McpPluginConfig {
  /**
   * Where the App MCP endpoint mounts.
   * @default '/mcp'
   */
  path?: string
  /** MCP server identity advertised to clients. Defaults to the package name. */
  serverInfo?: { name?: string; version?: string }
  /**
   * Per-token rate limits, on by default (`false` disables). Enforced in
   * process memory: exact on one long-running server, per-instance on a
   * fleet or serverless — a global budget needs the app's own rate-limit
   * middleware over a shared store.
   */
  rateLimit?: RateLimitConfig | false
  /**
   * Whether verifying a bearer writes the token's `lastUsedAt`.
   * @default true
   */
  updateLastUsed?: boolean
  /**
   * Where the audit trail is written (RFC 0016 §5.2). Omitted, there is no
   * sink and nothing is written — `AgentToolInvoked` / `AgentToolDenied` are
   * still emitted exactly as before, so an application that already forwards
   * events is already forwarding these.
   *
   * Opt-in on purpose. The runtimes this endpoint runs on include Workers and
   * Lambda, where a framework that started appending to a file on its own
   * would be writing to a read-only or ephemeral filesystem — and an audit
   * trail that silently degrades per runtime is worse than one an operator
   * knows is absent. What the default costs is one line of configuration; what
   * it would buy is a false sense of a record existing.
   *
   * `{ file, days }` appends JSONL through {@link DailyFileChannel}: one
   * record per line, rotated daily, files older than `days` swept on rotation.
   * `file` is a *base* path — the trail lands in `agent-audit-YYYY-MM-DD.log`
   * beside it — and is resolved by the filesystem, so an absolute path or one
   * relative to the process's working directory. It is not resolved against an
   * application root: `Application` exposes none, and guessing one would put
   * the trail somewhere the operator did not ask for.
   *
   * `{ sink }` hands each record to a function instead — the seam for a log
   * aggregator, a database, or anything else with its own delivery. A sink
   * that throws is warned about and does not fail the tool call it was
   * recording. It is *not* awaited before that call is answered, so a sink
   * whose delivery is asynchronous can still be in flight when a runtime that
   * freezes the isolate after the response does so: on Workers and Lambda,
   * either complete the write synchronously or hand it to the platform's own
   * keep-alive (`waitUntil`) inside the sink. The built-in file sink appends
   * synchronously and has nothing in flight to lose.
   *
   * Either form is called directly, not subscribed to the events — see `emit`
   * for why a record of what agents did must not depend on what else the
   * application listens for. It therefore records with or without an event
   * manager bound.
   *
   * @default undefined — no sink; events are emitted, nothing is written
   * @example
   * ```typescript
   * mcpPlugin({ audit: { file: 'storage/logs/agent-audit.log', days: 30 } })
   * ```
   */
  audit?: { file?: string; days?: number } | { sink: (record: AgentAuditRecord) => void | Promise<void> }
}

/**
 * The App MCP endpoint (RFC 0016 §7): the application's own agent tools —
 * routes declaring `.agent()` — served over the Model Context Protocol, in
 * production, behind bearer tokens.
 *
 * Every tool call re-enters the application through `app.fetch` as a real
 * HTTP request (§3): validation, policies, and middleware run exactly once,
 * in the app. The adapter's own checks are the ones that must precede HTTP —
 * bearer verification, token scopes, approval, rate limits — and each
 * refusal is an `AgentToolDenied` event; each execution an
 * `AgentToolInvoked`, arguments redacted (§5.2).
 *
 * Requires token auth: the app must call `auth.useTokens(store)` (or
 * configure it via its auth options), because the endpoint verifies bearers
 * against the same store the token guard uses. The check is per request, not
 * at boot — provider order does not guarantee the app's auth configuration
 * has run before this plugin boots.
 */
const factory = definePlugin<McpPluginConfig>({
  name: 'mcp',
  register(): void {
    // Everything binds per request; there is no container service to offer.
  },
  async boot(container, config): Promise<void> {
    const app = container.make<Application>('app')
    const auth = container.make<AuthManager>('auth')
    const events = container.has('events') ? container.make<EventManager>('events') : undefined
    if (!events) {
      console.warn(
        '[@guren/plugin-mcp] No event manager is bound (register EventServiceProvider); '
        + 'agent audit events (AgentToolInvoked / AgentToolDenied) will not be emitted.',
      )
    }

    const sink = config.audit ? await resolveAuditSink(config.audit) : undefined

    const { tools, warnings } = deriveAgentTools(app.router.definitions())
    for (const warning of warnings) {
      console.warn(`[@guren/plugin-mcp] ${warning}`)
    }
    const exposed = tools.filter((tool) => tool.expose.mcp)

    const path = config.path ?? '/mcp'
    const serverInfo = {
      name: config.serverInfo?.name ?? 'guren-app',
      version: config.serverInfo?.version ?? '1.0.0',
    }
    // Per-token, in this process. An app's *own* rate-limit middleware on an
    // agent route keys on `server.requestIP()`, which is null for the
    // synthesized re-entrant request (it never arrived over a socket) and so
    // collapses to that route's shared bucket for every MCP caller. This
    // limiter is the per-caller floor the app's cannot be on this surface; a
    // global budget across instances still needs a shared store.
    const limiter = config.rateLimit === false ? undefined : new AgentRateLimiter(config.rateLimit)

    // Dynamic import, mirroring the Dev MCP provider: the SDK stays out of
    // module graphs that never mount the endpoint.
    const { WebStandardStreamableHTTPServerTransport } = await import(
      '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
    )

    const emit = createAuditEmitter(sink, events)

    app.hono.all(path, async (c) => {
      const store = auth.getApiTokenStore()
      if (!store) {
        return c.json(
          {
            error: 'misconfigured',
            message:
              'The MCP endpoint requires token auth: call auth.useTokens(store) in your '
              + 'application so bearer tokens can be verified.',
          },
          500,
        )
      }

      const bearer = readBearerToken(c.req.header('Authorization'))
      if (!bearer) {
        return unauthorized(c, 'A bearer token is required.')
      }
      const verified = await verifyApiToken(bearer, store, {
        updateLastUsed: config.updateLastUsed ?? true,
      })
      if (!verified) {
        return unauthorized(c, 'The bearer token is invalid, expired, or revoked.')
      }

      const principal: AgentPrincipal = {
        kind: 'user',
        id: verified.userId,
        abilities: verified.abilities,
      }

      const server = createAppMcpServer({
        tools: exposed,
        abilities: verified.abilities,
        serverInfo,
        limiter,
        rateKey: verified.token.id,
        dispatch: (tool, args) => dispatchThroughApp(app, c, tool, args),
        onInvoked: (tool, args, status, durationMs) => {
          emit(
            new AgentToolInvoked(
              principal,
              tool.toolName,
              redactAgentArguments(args, tool.redact),
              status,
              durationMs,
              'mcp',
            ),
          )
        },
        onDenied: (tool, args, reason: AgentToolDenialReason) => {
          emit(
            new AgentToolDenied(
              principal,
              tool.toolName,
              redactAgentArguments(args, tool.redact),
              reason,
              'mcp',
            ),
          )
        },
      })

      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      })
      await server.connect(transport)
      return transport.handleRequest(c.req.raw)
    })
  },
})

/**
 * The function records are handed to, resolved once at boot.
 *
 * `{ sink }` is the application's own; `{ file }` is built here, behind a
 * dynamic `import()` so an application that configured a function never
 * evaluates the filesystem module — the same discipline the MCP SDK import
 * follows.
 */
async function resolveAuditSink(
  config: NonNullable<McpPluginConfig['audit']>,
): Promise<AgentAuditSink> {
  if ('sink' in config) return config.sink

  const { createFileAuditSink } = await import('./audit-file')
  return createFileAuditSink(config.file ?? DEFAULT_AGENT_AUDIT_PATH, config.days)
}

async function dispatchThroughApp(
  app: Application,
  c: Context,
  tool: DerivedAgentTool,
  args: Record<string, unknown>,
): Promise<ToolCallOutcome> {
  // No `preflight` option below, deliberately: preflight is *not* offered on
  // this surface, though the seam it uses is server-side and available to
  // every other one (RFC 0016 §5.4).
  //
  // MCP leaves no room for it inside a tool that advertises an `outputSchema`:
  // the spec requires such a tool to answer with `structuredContent`
  // conforming to that schema unless the result is an error, and a verdict
  // conforms to no route's output. Reporting "allowed" as `isError` would be
  // worse than not offering it. So the MCP form needs a companion tool with
  // its own result schema — which is the same problem the approval queue has
  // ("the tool result carries the pending state"), and belongs with it in
  // Phase 2.5 rather than being solved twice, differently.
  //
  // Nothing is lost meanwhile: `_preflight` was never advertised in any
  // tool's input schema, so no client could discover it. It reaches
  // `guren tool:call` and `@guren/testing` through the dispatch option
  // instead, neither of which is bound by that rule.
  const built = buildToolRequest(tool, args, {
    // The inbound request's own origin, so the re-entrant request carries the
    // real Host the MCP client reached `/mcp` on. Defaulting to localhost
    // (dispatch's fallback) makes host-authorization middleware — which RFC
    // 0016's "in production" apps are encouraged to enable — reject every
    // tool call with 403.
    origin: new URL(c.req.url).origin,
    authorization: c.req.header('Authorization'),
  })
  if ('missing' in built) {
    // No HTTP happened, but the call did — recorded by the caller as an
    // invocation with the status the app would have answered.
    return badRequest(`Missing required path parameter(s): ${built.missing.join(', ')}.`)
  }
  if ('invalidPath' in built) {
    return badRequest(
      `Path parameter(s) ${built.invalidPath.join(', ')} may not be "." or ".." — `
      + 'a dot-segment would resolve to a different route than the one authorized.',
    )
  }

  // env and execution context are forwarded explicitly — omitting them
  // silently loses D1/R2 bindings and waitUntil on Workers (RFC 0016 §3.1).
  return mapToolResponse(tool, await app.fetch(built.request, c.env, executionContext(c)))
}

/** A tool call the adapter rejected before HTTP — recorded as a 400 invocation. */
function badRequest(text: string): ToolCallOutcome {
  return { content: [{ type: 'text', text }], isError: true, status: 400 }
}

/** Hono throws on `executionCtx` outside Workers; absent is a normal answer here. */
function executionContext(c: Context): ExecutionContext | undefined {
  try {
    return c.executionCtx as ExecutionContext
  } catch {
    return undefined
  }
}

type ExecutionContext = Parameters<Application['fetch']>[2]

function unauthorized(c: Context, message: string): Response {
  c.header('WWW-Authenticate', 'Bearer')
  return c.json({ error: 'unauthorized', message }, 401)
}

/**
 * Register the App MCP plugin.
 *
 * @example
 * ```typescript
 * import { mcpPlugin } from '@guren/plugin-mcp'
 *
 * createApp({ providers: [mcpPlugin({ path: '/mcp' })] })
 * ```
 */
export function mcpPlugin(config: McpPluginConfig = {}): ServiceProviderConstructor {
  return factory(config)
}
