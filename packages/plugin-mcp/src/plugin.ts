import {
  AgentToolDenied,
  AgentToolInvoked,
  definePlugin,
  deriveAgentTools,
  readBearerToken,
  redactAgentArguments,
  verifyApiToken,
  type AgentPrincipal,
  type AgentToolDenialReason,
  type Application,
  type AuthManager,
  type DerivedAgentTool,
  type EventManager,
  type ServiceProviderConstructor,
} from '@guren/core'
import type { Context } from 'hono'

import { buildToolRequest, mapToolResponse, type ToolCallOutcome } from './dispatch'
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
    const limiter = config.rateLimit === false ? undefined : new AgentRateLimiter(config.rateLimit)

    // Dynamic import, mirroring the Dev MCP provider: the SDK stays out of
    // module graphs that never mount the endpoint.
    const { WebStandardStreamableHTTPServerTransport } = await import(
      '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
    )

    const emit = (event: AgentToolInvoked | AgentToolDenied): void => {
      // Fire-and-forget: a listener's failure must not fail the tool call it
      // records. EventManager already isolates listener errors; the catch
      // covers emit itself.
      void events?.emit(event).catch((error) => {
        console.warn(`[@guren/plugin-mcp] audit event listener failed: ${String(error)}`)
      })
    }

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

async function dispatchThroughApp(
  app: Application,
  c: Context,
  tool: DerivedAgentTool,
  args: Record<string, unknown>,
): Promise<ToolCallOutcome> {
  const built = buildToolRequest(tool, args, {
    authorization: c.req.header('Authorization'),
  })
  if ('missing' in built) {
    // No HTTP happened, but the call did — recorded by the caller as an
    // invocation with the status the app would have answered.
    return {
      content: [
        {
          type: 'text',
          text: `Missing required path parameter(s): ${built.missing.join(', ')}.`,
        },
      ],
      isError: true,
      status: 400,
    }
  }

  // env and execution context are forwarded explicitly — omitting them
  // silently loses D1/R2 bindings and waitUntil on Workers (RFC 0016 §3.1).
  return mapToolResponse(tool, await app.fetch(built.request, c.env, executionContext(c)))
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
