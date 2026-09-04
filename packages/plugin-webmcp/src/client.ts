/**
 * The WebMCP client (RFC 0016 §7, Phase 3) — **experimental**.
 *
 * Registers the tools an app's `.guren/agents.gen.ts` marks `expose.webMcp`
 * onto the browser's `modelContext` API: a tool call becomes the HTTP request
 * the route already validates, as the signed-in user. Imports from
 * `@guren/core/agent` and nothing else — `@guren/core` or `@guren/server`
 * would pull the container, Hono and the ORM into a browser bundle. WebMCP is
 * a W3C CG draft (the anchor moved from `navigator` to `document`,
 * `unregisterTool` has come and gone), so every feature detection here marks
 * something the draft already changed once.
 */
import {
  buildToolRequest,
  describeBuildFailure,
  mapToolResponse,
  type AgentToolInputSource,
  type DerivedAgentTool,
  type ToolCallOutcome,
} from '@guren/core/agent'

// The wire contract is owned by Guren's CSRF middleware: it writes the
// XSRF-TOKEN cookie and reads this header. Spelled exactly as the generated
// API client spells it (packages/cli/src/api-client-types.ts) — two clients
// on one page must send the same header, or one of them is rejected.
const XSRF_COOKIE_NAME = 'XSRF-TOKEN'
const XSRF_HEADER_NAME = 'X-XSRF-TOKEN'
/**
 * Methods that carry no CSRF token. QUERY is deliberately absent even though
 * the server's CSRF default skips it: a redundant token header is harmless,
 * and sending it keeps this client working against a server that protects it.
 */
const CSRF_SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * One entry of a generated `agentTools` manifest, structurally.
 *
 * Declared here rather than imported as `DerivedAgentTool` because the manifest
 * is emitted `as const`, and a `readonly string[]` is not assignable to the
 * `string[]` the derivation declares. The single cast back at the dispatch call
 * bridges them, sound because dispatch only ever reads the tool. The schemas
 * are `unknown` because this module never inspects them.
 */
export interface WebMcpToolSource {
  readonly toolName: string
  readonly method: string
  readonly path: string
  readonly description?: string
  readonly inputSchema: unknown
  readonly outputSchema?: unknown
  readonly annotations: {
    readonly readOnlyHint: boolean
    readonly destructiveHint: boolean
    readonly idempotentHint: boolean
  }
  readonly approval?: 'required'
  readonly expose: {
    readonly mcp: boolean
    readonly webMcp: boolean
  }
  readonly inputSources: Readonly<Record<string, AgentToolInputSource>>
  readonly inputBodyNested: boolean
}

/** An MCP tool result as a WebMCP host reads it. */
export interface WebMcpToolResult {
  content: Array<{ type: 'text'; text: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

/**
 * The descriptor handed to `modelContext.registerTool`. `description` is
 * **required** by the draft's `ModelContextTool` and an empty string is
 * rejected with `InvalidStateError`, which is why {@link registerAgentTools}
 * substitutes a fallback.
 */
export interface WebMcpToolDescriptor {
  name: string
  description: string
  inputSchema: unknown
  annotations?: unknown
  execute: (
    args?: Record<string, unknown>,
    context?: { readonly signal?: AbortSignal },
  ) => Promise<WebMcpToolResult>
}

/**
 * `ModelContextRegisterToolOptions`, the draft's second `registerTool`
 * argument. Aborting `signal` is how the current draft unregisters a tool;
 * it has no `unregisterTool` at all.
 */
export interface WebMcpRegisterToolOptions {
  signal?: AbortSignal
}

/**
 * The slice of the browser's `modelContext` this client uses. Structural
 * because there is no stable published type while the CG draft moves, and it
 * is also what makes the anchor injectable in a test.
 */
export interface ModelContextLike {
  registerTool(descriptor: WebMcpToolDescriptor, options?: WebMcpRegisterToolOptions): unknown
  /**
   * Present in earlier shipped hosts, absent from the current draft, which
   * replaced it with the abort signal above. Feature-detected at
   * unregistration time so a host of either generation can still register.
   */
  unregisterTool?(name: string): unknown
}

export interface RegisterAgentToolsOptions {
  /**
   * The anchor to register on, overriding detection — a testing and embedding
   * seam for a page with its own `modelContext` shim.
   */
  modelContext?: ModelContextLike
  /** `fetch` to dispatch through. Defaults to the page's own. */
  fetch?: typeof fetch
  /**
   * Register tools whose route declares `approval: 'required'`. Off by default
   * and fail-closed: the approval queue is reached through the App MCP endpoint
   * and WebMCP has no equivalent, so registering one here would offer an agent
   * a call the application asked a human to confirm, with no human in the loop.
   */
  includeApprovalRequired?: boolean
}

export interface WebMcpRegistration {
  /** Whether a `modelContext` anchor was found at all. */
  supported: boolean
  /** Tool names registered, in registration order. */
  registered: string[]
  /** Tools deliberately not registered, and why. */
  skipped: Array<{ tool: string; reason: 'expose' | 'approval' }>
  /**
   * Remove the tools this call registered, by both mechanisms the two host
   * generations offer: aborting the signal handed to `registerTool` and calling
   * `unregisterTool` per name. Best-effort, and safe on an unsupported
   * environment.
   */
  unregister(): Promise<void>
}

/**
 * Register an application's WebMCP-exposed agent tools on the page.
 *
 * A browser with no `modelContext` gets `{ supported: false }` and no
 * exception: this runs on every page load, and a missing experimental API is
 * the normal case. Registration failures are the opposite — see the loop below.
 *
 * @example
 * ```typescript
 * await registerAgentTools(agentTools)
 * ```
 */
export async function registerAgentTools(
  tools: Readonly<Record<string, WebMcpToolSource>>,
  options: RegisterAgentToolsOptions = {},
): Promise<WebMcpRegistration> {
  const skipped: Array<{ tool: string; reason: 'expose' | 'approval' }> = []
  const registered: string[] = []

  const anchor = resolveModelContext(options.modelContext)
  if (!anchor) {
    return { supported: false, registered, skipped, unregister: async () => {} }
  }

  // One controller for the whole call, so `unregister()` is a single abort.
  // Handed to every `registerTool`: a host on the current draft unregisters on
  // abort, and one predating the option drops an undeclared dictionary member,
  // so `unregisterTool` covers that generation instead. Both run on teardown —
  // the two are not distinguishable from outside, and doing both is idempotent.
  const lifetime = new AbortController()

  const candidates: WebMcpToolSource[] = []
  for (const tool of Object.values(tools)) {
    if (!tool.expose.webMcp) {
      skipped.push({ tool: tool.toolName, reason: 'expose' })
      continue
    }
    if (tool.approval === 'required' && !options.includeApprovalRequired) {
      skipped.push({ tool: tool.toolName, reason: 'approval' })
      continue
    }
    candidates.push(tool)
  }

  for (const tool of candidates) {
    try {
      // `registerTool` returns a promise in some hosts and nothing in
      // others; awaiting a non-promise is a no-op, so this covers both.
      await anchor.registerTool(
        {
          name: tool.toolName,
          description: describeTool(tool),
          inputSchema: tool.inputSchema,
          // Passed through unchanged: the draft's annotations dictionary is a
          // superset of what the derivation resolves, and WebIDL conversion
          // drops undeclared members. (`untrustedContentHint` is not derivable
          // from a route contract, so it is not sent.)
          annotations: tool.annotations,
          execute: (args, context) => executeTool(tool, args, context, options),
        },
        { signal: lifetime.signal },
      )
    } catch (error) {
      // Propagated, not collected: a registration failure means the manifest
      // and the host disagree — a duplicate name, a schema the host rejects —
      // which is a wiring mistake the developer has to see. Already-registered
      // tools come off first, so a caller that retries is not fighting a
      // half-registered page.
      await teardown(anchor, lifetime, registered)
      throw error
    }
    registered.push(tool.toolName)
  }

  return {
    supported: true,
    registered,
    skipped,
    unregister: () => teardown(anchor, lifetime, registered),
  }
}

/**
 * The description the host is given. `ModelContextTool.description` is required
 * and an empty one is rejected with `InvalidStateError`, while a Guren route's
 * `.agent()` description is optional — so the method and path stand in rather
 * than turning a `guren check` warning into a page that throws on load.
 */
function describeTool(tool: WebMcpToolSource): string {
  const declared = tool.description?.trim()
  return declared ? declared : `${tool.method} ${tool.path}`
}

/**
 * Where the page publishes its model context. `document` first: the draft moved
 * the anchor there and `navigator.modelContext` is the deprecated spelling
 * (removed in Chrome 150). Both are read through `globalThis`, and nothing is
 * touched at module scope, so this stays importable under SSR.
 */
function resolveModelContext(override?: ModelContextLike): ModelContextLike | undefined {
  if (override) return override
  const scope = globalThis as {
    document?: { modelContext?: ModelContextLike }
    navigator?: { modelContext?: ModelContextLike }
  }
  return scope.document?.modelContext ?? scope.navigator?.modelContext
}

/**
 * Remove the registered tools by both mechanisms; see
 * {@link WebMcpRegistration.unregister}. The abort goes first because it is the
 * current draft's only way and cannot fail, then the legacy per-name call.
 * Neither is conditional: from outside the two hosts are indistinguishable.
 */
async function teardown(
  anchor: ModelContextLike,
  lifetime: AbortController,
  names: readonly string[],
): Promise<void> {
  lifetime.abort()
  if (typeof anchor.unregisterTool !== 'function') return
  for (const name of names) {
    try {
      await anchor.unregisterTool(name)
    } catch {
      // A host that refuses to unregister one tool must not strand the rest.
    }
  }
}

/**
 * Turn one tool call into the HTTP request its route validates, and the
 * response back into an MCP tool result. The casts to `DerivedAgentTool` are
 * the ones {@link WebMcpToolSource} documents; both callees only read.
 */
async function executeTool(
  tool: WebMcpToolSource,
  args: Record<string, unknown> | undefined,
  context: { readonly signal?: AbortSignal } | undefined,
  options: RegisterAgentToolsOptions,
): Promise<WebMcpToolResult> {
  const derived = tool as DerivedAgentTool
  const built = buildToolRequest(derived, args ?? {}, {
    // The page's own origin, so the request is same-origin and carries the
    // session cookie. Absent under SSR, where dispatch's own default applies.
    origin: (globalThis as { location?: { origin?: string } }).location?.origin,
    surface: 'webmcp',
  })

  if (!('request' in built)) {
    return errorResult(describeBuildFailure(built))
  }

  applyCsrfToken(built.request)

  // Bound through a wrapper rather than passed as a bare reference:
  // `globalThis.fetch` invoked detached throws "Illegal invocation" in a
  // browser.
  const dispatch = options.fetch ?? ((input: Request, init?: RequestInit) => globalThis.fetch(input, init))

  let response: Response
  try {
    response = await dispatch(built.request, {
      signal: context?.signal,
      // Both pin the request to the app that served the page. The synthesized
      // Request would otherwise default to `cors` + `follow`, and this call
      // carries the session cookie's authority and the `X-XSRF-TOKEN` header:
      // `fetch` strips `Authorization` across a cross-origin redirect but *not*
      // custom headers, so one open redirect would replay both elsewhere.
      mode: 'same-origin',
      redirect: 'manual',
    })
  } catch (error) {
    // Returned rather than thrown: a rejected `execute` reaches the agent as a
    // host-level failure whose message is flattened or dropped, so an offline
    // tab would report "tool failed" with nothing to act on.
    return errorResult(`Request failed: ${describeError(error)}`)
  }

  // `redirect: 'manual'` turns *any* redirect into an opaque response (type
  // `opaqueredirect`, status 0, no readable headers), which `mapToolResponse`
  // would otherwise describe as something the route returned. A browser cannot
  // read the Location, and following it is the hazard above — a parity gap with
  // the App MCP surface. Not an error result: the route answered, and `isError`
  // would make an agent retry a call that did exactly what it should.
  if (response.type === 'opaqueredirect') {
    return {
      content: [
        {
          type: 'text',
          text:
            `The route "${tool.toolName}" answered with a redirect, which this client does not `
            + 'follow — a redirect off this origin would replay the request, its body and its '
            + 'CSRF token to another host. The redirect target is not readable from the page.',
        },
      ],
    }
  }

  return toWireResult(await mapToolResponse(derived, response))
}

/**
 * Copy the CSRF cookie into the header Guren's middleware reads, for the
 * methods it protects. Absent cookie, no header: the app may run with
 * `csrf({ cookie: false })`, and an empty token would turn a call into a 403.
 */
function applyCsrfToken(request: Request): void {
  if (CSRF_SAFE_METHODS.has(request.method.toUpperCase())) return
  const token = readXsrfToken()
  if (token) request.headers.set(XSRF_HEADER_NAME, token)
}

/**
 * Read the `XSRF-TOKEN` cookie issued by Guren's CSRF middleware, through
 * `globalThis` so the module stays importable outside a browser.
 */
function readXsrfToken(): string | undefined {
  const cookies = (globalThis as { document?: { cookie?: string } }).document?.cookie
  if (!cookies) return undefined
  for (const part of cookies.split(';')) {
    const entry = part.trim()
    if (!entry.startsWith(`${XSRF_COOKIE_NAME}=`)) continue
    const value = entry.slice(XSRF_COOKIE_NAME.length + 1)
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }
  return undefined
}

/**
 * The MCP-shaped subset of a dispatch outcome. `status` and `preflightVerdict`
 * are dropped: they exist for the App MCP endpoint's audit trail, and a WebMCP
 * host has none. The content array alone is also the intersection every shipped
 * WebMCP implementation accepts.
 */
function toWireResult(outcome: ToolCallOutcome): WebMcpToolResult {
  const result: WebMcpToolResult = { content: outcome.content }
  if (outcome.structuredContent) result.structuredContent = outcome.structuredContent
  if (outcome.isError) result.isError = true
  return result
}

function errorResult(text: string): WebMcpToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
