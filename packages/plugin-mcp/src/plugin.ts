import {
  AGENT_AUDIT_BINDING,
  AgentToolDenied,
  AgentToolInvoked,
  DEFAULT_AGENT_AUDIT_PATH,
  createAgentApprovalContext,
  createAgentInvocationPipeline,
  createAuditEmitter,
  definePlugin,
  deriveAgentTools,
  isReservedAgentToolName,
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
  type EventManager,
  type ServiceProviderConstructor,
} from '@guren/core'
import type { Context } from 'hono'

import { readExternalMcpAuth, type ExternalMcpAuth } from './external-auth'
import { AgentRateLimiter, createRateLimitInterposition, type RateLimitConfig } from './rate-limit'
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
   * `'external'`: every request arrives verified by an authority in front of the
   * app, over the seam in `./external-auth` (never a header); no token store is
   * consulted, and a request without the seam is refused 401 rather than falling
   * back to bearer. It authenticates *inside* the app too — see {@link fromExternalAuth}.
   * @default undefined — bearer tokens
   */
  auth?: 'external'
  /**
   * Audit trail (RFC 0016 §5.2), opt-in because Workers and Lambda filesystems
   * are read-only or ephemeral. `file` is a *base* path: the trail lands in
   * `agent-audit-YYYY-MM-DD.log` beside it, rotated daily. A `sink` is not
   * awaited (write synchronously, or hand it to `waitUntil`); a throw warns.
   * @default undefined — no sink; events are emitted, nothing is written
   */
  audit?: { file?: string; days?: number } | { sink: (record: AgentAuditRecord) => void | Promise<void> }
  /**
   * The approval queue (RFC 0016 §5.4 item 4): an `approval: 'required'` route
   * answers with a request id; approved, the same call with the same arguments
   * runs once. No memory-backed default — Workers or Lambda would answer "approved"
   * for a record the next isolate never saw. `notify` is unawaited, post-persist.
   * @default undefined — no queue; such tools are refused fail-closed and unlisted
   */
  approvals?: {
    store: AgentApprovalStore
    notify: (request: AgentApprovalRequest) => void | Promise<void>
    /** @default 1 hour (`DEFAULT_AGENT_APPROVAL_TTL_MS`) */
    ttlMs?: number
  }
}

/**
 * The App MCP endpoint (RFC 0016 §7). Every tool call re-enters the app through
 * `app.fetch` as a real HTTP request (§3), so validation, policies and middleware
 * run once, in the app; the adapter owns only what precedes HTTP — bearer
 * verification, scopes, approval, rate limits. The token store is read per
 * request: provider order does not guarantee the app's auth configured first.
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

      const { principal, abilities, rateKey, credential } = resolved

      // Rebuilt per request because the principal is: an approval is bound to
      // who asked, and a context hoisted to boot would carry whichever caller
      // arrived first. One object for both halves — the gate that files records
      // and the status tool that reports on them — so the two cannot disagree
      // about whether a queue exists; the server reads only three of its keys.
      const approvals = createAgentApprovalContext(config.approvals, principal)

      const executionCtx = executionContext(c)

      const pipeline = createAgentInvocationPipeline({
        app,
        principal,
        abilities,
        surface: 'mcp',
        audit: emit,
        ...(approvals ? { approvals } : {}),
        // The pipeline is protocol-neutral, so both the configuration line in
        // a fail-closed refusal and the subject of a scope refusal have to
        // come from the surface. These two keep the text an MCP client reads
        // exactly what it has always read.
        approvalConfigureHint: 'mcpPlugin({ approvals: { store, notify } })',
        // This surface really does authenticate by a token, so it says so. The
        // pipeline's default is neutral, because a durable agent's principal
        // is minted from its registration and holds no token to widen.
        scopeSubject: "The token's scopes",
        // The plugin's own metering, as the pipeline's one interposition hook —
        // undefined when `rateLimit: false`, so the pipeline holds no hook at
        // all rather than one that always allows.
        interpose: createRateLimitInterposition(limiter, rateKey),
        // The inbound request's own origin, so the re-entrant request carries
        // the real Host the MCP client reached `/mcp` on. Defaulting to
        // localhost (dispatch's fallback) makes host-authorization middleware
        // — which RFC 0016's "in production" apps are encouraged to enable —
        // reject every tool call with 403.
        origin: new URL(c.req.url).origin,
        // A forwarded credential or the principal seam, never both. See
        // `ResolvedCaller.credential`.
        ...credential,
        // env and execution context are forwarded explicitly — omitting them
        // silently loses D1/R2 bindings and waitUntil on Workers (RFC 0016
        // §3.1).
        env: c.env,
        ...(executionCtx ? { executionCtx } : {}),
      })

      const server = createAppMcpServer({
        tools: exposed,
        abilities,
        ...(approvals ? { approvals } : {}),
        serverInfo,
        pipeline,
        limiter,
        rateKey,
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
  /**
   * What the dispatched request answers "who is this" with, spread into the
   * pipeline's options. A union, not two optional fields, because the two are
   * alternatives: a caller presents a credential the app verifies
   * (`{ authorization }`) or the framework hands over the identity it
   * established (`{ handoff: 'seam' }`). The pipeline refuses both at once.
   */
  credential: { authorization: string } | { handoff: 'seam' }
}

/**
 * A caller the seam presented, verified by an authority in front of the app.
 * `rateKey` is per principal — no token to key on — coarser, so it can only
 * limit more. No `Authorization` is forwarded, the caller's bearer being the
 * *provider's*; the principal is installed instead (RFC 0017 §2), so
 * `requireAuthenticated()` passes and `tokenCan*` refuses for want of a token.
 */
function fromExternalAuth(external: ExternalMcpAuth): ResolvedCaller {
  return {
    principal: external.principal,
    abilities: external.scopes,
    rateKey: `external:${external.principal.kind}:${String(external.principal.id)}`,
    credential: { handoff: 'seam' },
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
  // `bearer` cannot be present without `header`, but only the explicit check
  // narrows it — and the header itself, not the parsed token, is what the
  // resolved caller forwards verbatim.
  if (!header || !bearer) {
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
    credential: { authorization: header },
  }
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
