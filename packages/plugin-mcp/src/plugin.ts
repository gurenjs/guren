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
   * How a request to this endpoint is authenticated.
   *
   * Unset (the default) is the bearer contract this endpoint has always had:
   * the app must call `auth.useTokens(store)`, every request presents an
   * `Authorization: Bearer`, and the token's `abilities` are the scopes.
   *
   * `'external'` declares that **every** request arrives already verified by
   * something in front of the app — today, the OAuth provider a worker built
   * with `guren cloudflare:build --mcp-oauth` wraps the app in. That authority
   * hands the principal in over an in-process request-identity seam (see
   * `./external-auth`), never a header.
   *
   * Fail-closed in both directions, which is the whole reason this is an
   * explicit option rather than an inference:
   *
   * - **With** `'external'`, a request carrying no seam auth is refused 401.
   *   It never falls back to bearer verification, so an OAuth-fronted
   *   deployment cannot be reached by presenting a token the provider was
   *   supposed to be the only issuer of, and a deployment whose provider
   *   wrapping was lost in a rebuild fails loudly instead of quietly
   *   accepting a different credential.
   * - **Without** it, seam auth is still honoured when present — the generated
   *   worker is inside the trust boundary — but a request without it takes the
   *   unchanged bearer path, including the 500 an app with no token store
   *   already answers. An app that has both surfaces keeps both.
   *
   * An app configured `'external'` needs no `ApiToken` store at all: the store
   * is consulted only to verify a bearer, and under this option there is never
   * a bearer to verify.
   *
   * @default undefined — bearer tokens
   */
  auth?: 'external'
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
  /**
   * The approval queue (RFC 0016 §5.4 item 4). A route declaring
   * `agent({ approval: 'required' })` does not execute on request: the call
   * becomes a pending record, the approvers are told, and the tool answers
   * with the request id instead. Once a human approves it, repeating the same
   * call with the same arguments performs it — once.
   *
   * Opt-in, with no default implementation, for the reason `audit` has none:
   * this endpoint runs on Workers and Lambda, where a queue that quietly fell
   * back to process memory would answer "approved" for a record the next
   * isolate never saw, and would do it differently per deployment while the
   * configuration looked identical. Unconfigured, an `approval: 'required'`
   * tool is **refused fail-closed** and is absent from `tools/list`; the
   * refusal names this option. What the opt-in costs is a line of
   * configuration; what a default would buy is a gate that looks present.
   *
   * `store` is the application's own persistence — see `AgentApprovalStore`
   * for the four methods and the two guarantees an implementation owes
   * (`consume` is a compare-and-set; `findMatch` filters neither expiry nor
   * status).
   *
   * `notify` hands the request to the application, which decides who hears
   * about it: the framework never chooses approvers, because it cannot see the
   * list. `AgentApprovalRequested` is the ready-made notification for the
   * common case. A `notify` that throws or rejects is warned about and does
   * **not** fail the tool call or lose the record — the record is persisted
   * before `notify` is called, and is not awaited after.
   *
   * `ttlMs` is how long a new request stays answerable.
   *
   * @default undefined — no queue; approval-gated tools are refused fail-closed
   * @example
   * ```typescript
   * mcpPlugin({
   *   approvals: {
   *     store: new DrizzleApprovalStore(db),
   *     notify: (request) => notifications.sendToMany(admins, new AgentApprovalRequested(request)),
   *   },
   * })
   * ```
   */
  approvals?: {
    store: AgentApprovalStore
    notify: (request: AgentApprovalRequest) => void | Promise<void>
    /** @default 1 hour ({@link DEFAULT_AGENT_APPROVAL_TTL_MS}) */
    ttlMs?: number
  }
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
 *
 * The one exception is a request whose caller some authority *in front of* the
 * app already verified, presented over the request-identity seam in
 * `./external-auth` — an OAuth-fronted Workers deployment built with
 * `guren cloudflare:build --mcp-oauth`. Such a request never touches the token
 * store, so an app serving only that surface configures `auth: 'external'` and
 * needs no store at all.
 */
const factory = definePlugin<McpPluginConfig>({
  name: 'mcp',
  register(): void {
    // The endpoint's own state binds per request. The one service this plugin
    // offers — the audit emitter, under `AGENT_AUDIT_BINDING` — cannot be
    // registered here: it closes over a sink resolved asynchronously and over
    // the event manager, neither of which exists until `boot`.
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

    // A route whose tool name is one the endpoint adds itself (RFC 0016
    // §5.4). `createAppMcpServer` drops it — two tools with one name makes an
    // MCP client reject the entire catalogue — but silently dropping a route
    // an application declared would be the endpoint deciding not to serve it
    // without saying so. `guren check` fails the build over the same
    // collision; this is what an app that never ran the check sees.
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
    if (sink) {
      // Published under the name `ServiceBindings` declares, so a surface that
      // is not this endpoint records into the same trail rather than standing
      // up a second one. `guren tool:call` is the first such caller: it boots
      // the app, resolves this, and records its own invocations with
      // `surface: 'cli'` (RFC 0016 §5.2). It cannot import this package — the
      // CLI does not depend on it — and a CLI that built its own emitter
      // around its own sink would be a second audit configuration the
      // application never asked for, disagreeing with this one about where
      // records go.
      //
      // Bound only when a sink was configured, because the binding's whole
      // meaning to another surface is "there is somewhere to write". This
      // endpoint emits the *events* either way — it is long-lived, and its
      // listeners are the application's own — but a one-shot `guren tool:call`
      // resolving an emitter with no sink would run application listeners in a
      // process about to exit and still write nothing. Absent binding, absent
      // trail: the same absence this option's own default has.
      //
      // `instance`, not `singleton`: the emitter closes over the sink resolved
      // above and the app's event manager, both settled here, so there is
      // nothing left to construct lazily.
      container.instance(AGENT_AUDIT_BINDING, emit)
    }

    app.hono.all(path, async (c) => {
      // Consulted *first*, and on the raw request object rather than anything
      // rebuilt from it: a hit means an authority in front of the app already
      // verified this caller, so the bearer machinery below — the token store
      // included — is not merely unnecessary but wrong to consult.
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
        // Rebuilt per request because the principal is: an approval is bound
        // to who asked for it, and a context hoisted to boot would carry
        // whichever caller happened to arrive first.
        ...(config.approvals
          ? {
              approvals: {
                store: config.approvals.store,
                principal,
                ttlMs: config.approvals.ttlMs ?? DEFAULT_AGENT_APPROVAL_TTL_MS,
                now: () => new Date(),
                // The route's own masking rules, the same walk the audit trail
                // uses. A record a human reads and a store persists must not
                // carry a field the route declared must never be written down.
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

/**
 * Everything a resolved caller settles for the rest of the request: who they
 * are, what they may reach, what the rate limiter counts them under, and what
 * — if anything — the re-entrant HTTP request should present as its own
 * credential.
 */
interface ResolvedCaller {
  principal: AgentPrincipal
  abilities: readonly string[]
  /**
   * The rate limiter's bucket key. Never `undefined`: a missing key silently
   * turns the per-caller limiter into no limiter at all, which is a security
   * regression that no test of the *happy* path can see.
   */
  rateKey: string
  /**
   * `Authorization` to forward into the dispatched request, or `undefined` for
   * a surface whose credential the application cannot verify.
   */
  authorization: string | undefined
}

/**
 * A caller the seam presented — verified by an authority in front of the app.
 *
 * Two deliberate differences from the bearer path, both narrowing:
 *
 * - **`rateKey` is per principal, not per token.** There is no token here to
 *   key on. Coarser by construction: two OAuth grants to the same user share
 *   one bucket, where two API tokens for that user would not. That is the
 *   right direction for a floor — it can only limit more, never less — and a
 *   per-grant budget is the provider's to enforce, not this endpoint's.
 * - **No `Authorization` is forwarded.** The bearer the caller presented is
 *   the *provider's* access token; the application's own token guard has never
 *   seen it and cannot verify it, so forwarding it would hand the app a
 *   credential nothing in it can judge — and put an unrelated authority's
 *   secret into whatever the app does with that header. The re-entrant request
 *   is therefore unauthenticated as far as the app's own guards are concerned:
 *   this endpoint's scope gate and the route's policies still run, but a route
 *   behind `requireApiToken` answers 401 on this surface. Closing that needs
 *   the auth context itself to consult a principal seam, which is RFC 0017 §2
 *   and not this change.
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
 * The bearer path, unchanged in behaviour and in order — store, then header,
 * then verification — so an app that never presents the seam sees exactly what
 * it saw before.
 *
 * `auth: 'external'` short-circuits it entirely: that option declares every
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
 * Wrap the application's `notify` so a notification failure can neither fail
 * the tool call nor lose the record.
 *
 * The same fire-and-forget-but-say-so discipline as the audit sink, and for
 * the same reason: the record is already persisted when this runs, so a
 * channel that is down costs an approver an email, not a request. Silence
 * would be worse than the failure — an approval nobody was told about looks
 * exactly like one nobody has answered yet — so the failure is warned about
 * with the request id in it, which is what an operator needs to find the
 * record that is sitting there unannounced.
 *
 * Both failure shapes are covered: a synchronous throw and a rejected promise.
 * The first is the one a hand-written `notify` produces before it ever reaches
 * its first `await`.
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
  authorization: string | undefined,
  preflight?: boolean,
): Promise<ToolCallOutcome> {
  // `preflight` is never an argument of the tool being checked on this
  // surface, and the flag below is not reachable from one: it comes from the
  // `guren.preflight` companion tool, which takes the checked tool's name and
  // arguments and answers with its own output schema (RFC 0016 §5.4).
  //
  // MCP leaves no room for the argument form. A tool advertising an
  // `outputSchema` must answer with `structuredContent` conforming to it
  // unless the result is an error, and a verdict conforms to no route's
  // output — so a tool that sometimes returns a verdict is a tool that
  // sometimes violates its own contract, and reporting "allowed" as `isError`
  // to escape that would be worse than not offering preflight at all.
  //
  // The seam it reaches is the same one `guren tool:call` and `@guren/testing`
  // use through this option directly; neither is bound by that rule.
  const built = buildToolRequest(tool, args, {
    // The inbound request's own origin, so the re-entrant request carries the
    // real Host the MCP client reached `/mcp` on. Defaulting to localhost
    // (dispatch's fallback) makes host-authorization middleware — which RFC
    // 0016's "in production" apps are encouraged to enable — reject every
    // tool call with 403.
    origin: new URL(c.req.url).origin,
    // Passed in rather than read off the inbound request: on the seam surface
    // the inbound `Authorization` belongs to an authority the application
    // cannot verify — see `fromExternalAuth`.
    authorization,
    preflight,
  })
  if (!('request' in built)) {
    // No HTTP happened, but the call did — recorded by the caller as an
    // invocation with the status the app would have answered.
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
