import {
  AGENT_AUDIT_BINDING,
  AgentToolDenied,
  AgentToolInvoked,
  DEFAULT_AGENT_AUDIT_PATH,
  DEFAULT_AGENT_APPROVAL_TTL_MS,
  buildToolRequest,
  createAuditEmitter,
  definePlugin,
  describeBuildFailure,
  deriveAgentTools,
  isReservedAgentToolName,
  mapToolResponse,
  readBearerToken,
  redactAgentArguments,
  verifyApiToken,
  type AgentApprovalRequest,
  type AgentApprovalStore,
  type AgentAuditRecord,
  type AgentAuditSink,
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

import { readExternalMcpAuth, type ExternalMcpAuth } from './external-auth'
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
   * process memory: per-instance on a fleet or serverless — a global budget
   * needs the app's own rate-limit middleware over a shared store.
   */
  rateLimit?: RateLimitConfig | false
  /**
   * Whether verifying a bearer writes the token's `lastUsedAt`.
   * @default true
   */
  updateLastUsed?: boolean
  /**
   * How a request to this endpoint is authenticated. `'external'` declares that
   * every request arrives already verified by an authority in front of the app,
   * handed in over the seam in `./external-auth` (never a header): no token
   * store is consulted, and a request without the seam is refused 401 rather
   * than falling back to bearer. Unset, the seam is still honoured when present
   * and everything else takes the bearer path.
   *
   * @default undefined — bearer tokens
   */
  auth?: 'external'
  /**
   * Where the audit trail is written (RFC 0016 §5.2). Opt-in because Workers
   * and Lambda filesystems are read-only or ephemeral; omitted, nothing is
   * written and the events are still emitted. `file` is a *base* path — the
   * trail lands in `agent-audit-YYYY-MM-DD.log` beside it, rotated daily. A
   * `sink` is not awaited (write synchronously, or hand the write to
   * `waitUntil`) and a throw is warned about rather than failing the call.
   *
   * @default undefined — no sink; events are emitted, nothing is written
   * @example mcpPlugin({ audit: { file: 'storage/logs/agent-audit.log', days: 30 } })
   */
  audit?: { file?: string; days?: number } | { sink: (record: AgentAuditRecord) => void | Promise<void> }
  /**
   * The approval queue (RFC 0016 §5.4 item 4). A route declaring
   * `agent({ approval: 'required' })` answers with a request id instead of
   * executing; once approved, the same call with the same arguments performs it
   * once. Unconfigured, such a tool is refused fail-closed and absent from
   * `tools/list` — a memory-backed default would answer "approved" on Workers
   * or Lambda for a record the next isolate never saw. `notify` runs after the
   * record is persisted and is not awaited: a throw is warned about, never
   * fatal, and never loses the record.
   *
   * @default undefined — no queue; approval-gated tools are refused fail-closed
   * @example mcpPlugin({ approvals: { store, notify } })
   */
  approvals?: {
    store: AgentApprovalStore
    notify: (request: AgentApprovalRequest) => void | Promise<void>
    /** @default 1 hour ({@link DEFAULT_AGENT_APPROVAL_TTL_MS}) */
    ttlMs?: number
  }
}

/**
 * The App MCP endpoint (RFC 0016 §7): routes declaring `.agent()` served over
 * the Model Context Protocol behind bearer tokens. Every tool call re-enters
 * the application through `app.fetch` as a real HTTP request (§3), so
 * validation, policies and middleware run once, in the app; the adapter owns
 * only what must precede HTTP — bearer verification, scopes, approval, rate
 * limits. The token store is read per request, because provider order does not
 * guarantee the app's auth configuration has run before this plugin boots.
 */
const factory = definePlugin<McpPluginConfig>({
  name: 'mcp',
  register(): void {
    // The audit emitter, this plugin's one service, cannot be registered here:
    // it closes over a sink resolved asynchronously and over the event manager,
    // neither of which exists until `boot`. Everything else binds per request.
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

    // `createAppMcpServer` drops a route claiming a reserved tool name (two
    // tools with one name makes an MCP client reject the entire catalogue).
    // `guren check` fails over the same collision; this is what an app that
    // never ran the check sees instead of a silent omission.
    for (const tool of exposed.filter((candidate) => isReservedAgentToolName(candidate.toolName))) {
      console.warn(
        `[@guren/plugin-mcp] The route "${tool.routeName}" claims the reserved tool name `
        + `"${tool.toolName}", which this endpoint serves itself. It is not exposed. `
        + 'Rename the route or set agent.toolName.',
      )
    }

    const path = config.path ?? '/mcp'
    const serverInfo = {
      name: config.serverInfo?.name ?? 'guren-app',
      version: config.serverInfo?.version ?? '1.0.0',
    }
    // Per-token, in this process. An app's own rate-limit middleware keys on
    // `server.requestIP()`, which is null for the synthesized re-entrant request
    // and so collapses every MCP caller into one shared bucket; a global budget
    // across instances still needs a shared store.
    const limiter = config.rateLimit === false ? undefined : new AgentRateLimiter(config.rateLimit)

    // Dynamic: the SDK stays out of module graphs that never mount the endpoint.
    const { WebStandardStreamableHTTPServerTransport } = await import(
      '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
    )

    const emit = createAuditEmitter(sink, events)
    if (sink) {
      // Published under the name `ServiceBindings` declares, so another surface
      // — `guren tool:call`, which cannot import this package — records into
      // this trail instead of standing up a second audit configuration. Bound
      // only when a sink exists: to another surface the binding means "there is
      // somewhere to write", so absent binding, absent trail.
      container.instance(AGENT_AUDIT_BINDING, emit)
    }

    app.hono.all(path, async (c) => {
      // Consulted first, on the raw request: a hit means an authority in front
      // of the app already verified this caller, so the bearer machinery below
      // — the token store included — is wrong to consult, not just redundant.
      const external = readExternalMcpAuth(c.req.raw)

      const resolved = external
        ? fromExternalAuth(external)
        : await verifyBearer(c, auth, config)

      if (resolved instanceof Response) {
        return resolved
      }

      const { principal, abilities, rateKey, authorization } = resolved

      const server = createAppMcpServer({
        tools: exposed,
        abilities,
        // Rebuilt per request: an approval is bound to who asked for it, and a
        // context hoisted to boot would carry whichever caller arrived first.
        ...(config.approvals
          ? {
              approvals: {
                store: config.approvals.store,
                principal,
                ttlMs: config.approvals.ttlMs ?? DEFAULT_AGENT_APPROVAL_TTL_MS,
                now: () => new Date(),
                // A record a human reads and a store persists must not carry a
                // field the route declared must never be written down.
                redact: (tool, args) => redactAgentArguments(args, tool.redact),
                notify: notifyApprovers(config.approvals.notify),
              },
            }
          : {}),
        serverInfo,
        limiter,
        rateKey,
        dispatch: (tool, args, dispatchOptions) =>
          dispatchThroughApp(app, c, tool, args, authorization, dispatchOptions?.preflight),
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

interface ResolvedCaller {
  principal: AgentPrincipal
  abilities: readonly string[]
  /** Never `undefined`: a missing key silently turns off the per-caller limiter. */
  rateKey: string
  /** `Authorization` to forward, or `undefined` when the app cannot verify it. */
  authorization: string | undefined
}

/**
 * A caller the seam presented, verified by an authority in front of the app.
 * `rateKey` is per principal — there is no token to key on — which is coarser
 * and so can only limit more. No `Authorization` is forwarded: the caller's
 * bearer is the *provider's*, which the app's token guard cannot verify, so the
 * re-entrant request is unauthenticated to the app's own guards and a route
 * behind `requireApiToken` answers 401 on this surface (closing that is
 * RFC 0017 §2).
 */
function fromExternalAuth(external: ExternalMcpAuth): ResolvedCaller {
  return {
    principal: external.principal,
    abilities: external.scopes,
    rateKey: `external:${external.principal.kind}:${String(external.principal.id)}`,
    authorization: undefined,
  }
}

/**
 * `auth: 'external'` short-circuits this entirely: that option declares every
 * request arrives seam-authenticated, so a request without the seam is refused
 * rather than offered a second way in.
 *
 * @returns the resolved caller, or the `Response` to answer with.
 */
async function verifyBearer(
  c: Context,
  auth: AuthManager,
  config: McpPluginConfig,
): Promise<ResolvedCaller | Response> {
  if (config.auth === 'external') {
    return unauthorized(
      c,
      'This endpoint is configured for external authentication (mcpPlugin({ auth: \'external\' })): '
      + 'requests must arrive through the authenticating layer in front of the application.',
    )
  }

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

  const header = c.req.header('Authorization')
  const bearer = readBearerToken(header)
  if (!bearer) {
    return unauthorized(c, 'A bearer token is required.')
  }
  const verified = await verifyApiToken(bearer, store, {
    updateLastUsed: config.updateLastUsed ?? true,
  })
  if (!verified) {
    return unauthorized(c, 'The bearer token is invalid, expired, or revoked.')
  }

  return {
    principal: { kind: 'user', id: verified.userId, abilities: verified.abilities },
    abilities: verified.abilities,
    rateKey: verified.token.id,
    authorization: header,
  }
}

/**
 * Wrap the application's `notify` so a failure can neither fail the tool call
 * nor lose the record — it is already persisted — but is still warned about
 * with the request id: an approval nobody was told about looks exactly like one
 * nobody has answered yet. Both a synchronous throw and a rejection are covered.
 */
export function notifyApprovers(
  notify: (request: AgentApprovalRequest) => void | Promise<void>,
): (request: AgentApprovalRequest) => void {
  return (request) => {
    try {
      void Promise.resolve(notify(request)).catch((error) => warnNotifyFailure(request, error))
    } catch (error) {
      warnNotifyFailure(request, error)
    }
  }
}

function warnNotifyFailure(request: AgentApprovalRequest, error: unknown): void {
  console.warn(
    `[@guren/plugin-mcp] approval notification failed for request ${request.id} `
    + `(${request.tool}); the request is recorded and pending, but nobody was told: ${String(error)}`,
  )
}

/**
 * `{ file }` is built behind a dynamic `import()` so an application that
 * configured its own `sink` never evaluates the filesystem module.
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
  authorization: string | undefined,
  preflight?: boolean,
): Promise<ToolCallOutcome> {
  // `preflight` is not an argument of the tool being checked: it comes from the
  // `guren.preflight` companion tool (RFC 0016 §5.4). MCP leaves no room for the
  // argument form — a tool advertising an `outputSchema` must answer with
  // conforming `structuredContent`, and a verdict conforms to no route's output.
  const built = buildToolRequest(tool, args, {
    // The real Host the MCP client reached `/mcp` on. Dispatch's localhost
    // fallback makes host-authorization middleware 403 every tool call.
    origin: new URL(c.req.url).origin,
    // Not read off the inbound request: on the seam surface that header belongs
    // to an authority the application cannot verify — see `fromExternalAuth`.
    authorization,
    preflight,
  })
  if (!('request' in built)) {
    return badRequest(describeBuildFailure(built))
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
 * @example createApp({ providers: [mcpPlugin({ path: '/mcp' })] })
 */
export function mcpPlugin(config: McpPluginConfig = {}): ServiceProviderConstructor {
  return factory(config)
}
