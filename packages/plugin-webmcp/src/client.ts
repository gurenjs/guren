/**
 * The WebMCP client (RFC 0016 §7, Phase 3) — **experimental**.
 *
 * Registers the tools an application's `.guren/agents.gen.ts` marks
 * `expose.webMcp` onto the browser's `modelContext` API, so an in-page agent
 * calls them as the signed-in user: same session cookie, same CSRF token,
 * same policies, same validation. Nothing here re-implements any of that —
 * a tool call is turned back into the HTTP request the route already
 * validates, by the framework's one dispatch contract.
 *
 * **Import discipline.** This module imports from `@guren/core/agent` and
 * nothing else. Never from `@guren/core` or `@guren/server`: their indexes
 * pull the container, Hono, the ORM and the whole application graph into what
 * is a browser bundle. The `/agent` subpath exists precisely so this file can
 * have `buildToolRequest` without any of that.
 *
 * **Experimental.** WebMCP is a W3C Community Group draft. The anchor moved
 * from `navigator.modelContext` to `document.modelContext`, `unregisterTool`
 * has come and gone across revisions, and the result shape is still settling.
 * Every place this file feature-detects rather than assumes is a place the
 * draft has already changed once.
 */
import {
  buildToolRequest,
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
 * and sending it is what keeps this client working against a server that opts
 * QUERY into protection.
 */
const CSRF_SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * One entry of a generated `agentTools` manifest, structurally.
 *
 * Declared here rather than imported as `DerivedAgentTool` because the
 * manifest is emitted `as const`: every property is `readonly` and every
 * array is a `readonly` array, and a `readonly string[]` is not assignable to
 * the `string[]` the derivation's own type declares. So the shape a caller
 * can actually satisfy is this one, and the single cast back to
 * `DerivedAgentTool` at the dispatch call is what bridges them — sound
 * because dispatch only ever reads the tool.
 *
 * `inputSchema` and `outputSchema` are `unknown` on purpose: this module
 * never inspects them, it forwards `inputSchema` to the host and hands the
 * tool to `mapToolResponse`, which reads the schema through its own type.
 * Naming a schema type here would be a second description of a shape the
 * framework already owns.
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

/** The descriptor handed to `modelContext.registerTool`. */
export interface WebMcpToolDescriptor {
  name: string
  description?: string
  inputSchema: unknown
  annotations?: unknown
  execute: (
    args?: Record<string, unknown>,
    context?: { readonly signal?: AbortSignal },
  ) => Promise<WebMcpToolResult>
}

/**
 * The slice of the browser's `modelContext` this client uses.
 *
 * Structural rather than a reference to a published type: there is no stable
 * one to reference while the CG draft moves, and a structural declaration is
 * also what makes the anchor injectable in a test.
 */
export interface ModelContextLike {
  registerTool(descriptor: WebMcpToolDescriptor): unknown
  /**
   * Optional because it is not in every revision of the draft. Feature-
   * detected at unregistration time rather than at registration: a host that
   * cannot unregister should still be able to register.
   */
  unregisterTool?(name: string): unknown
}

export interface RegisterAgentToolsOptions {
  /**
   * The anchor to register on, overriding detection. A testing and embedding
   * seam — a page with its own `modelContext` shim passes it here rather than
   * assigning onto `document`.
   */
  modelContext?: ModelContextLike
  /** `fetch` to dispatch through. Defaults to the page's own. */
  fetch?: typeof fetch
  /**
   * Register tools whose route declares `approval: 'required'`.
   *
   * Off by default, and that default is fail-closed rather than tidy: the
   * server-side approval queue is reached through the App MCP endpoint, and
   * WebMCP has no equivalent — so registering such a tool here offers an
   * agent a call the application asked a human to confirm first, with no
   * human in the loop. Turning it on is the explicit statement that the page
   * itself confirms those calls.
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
   * Remove the tools this call registered. Best-effort: a host with no
   * `unregisterTool` is a no-op, and a name that fails to unregister does not
   * stop the rest. Safe to call on an unsupported environment.
   */
  unregister(): Promise<void>
}

/**
 * Register an application's WebMCP-exposed agent tools on the page.
 *
 * @example
 * ```typescript
 * import { agentTools } from '@/.guren/agents.gen'
 * import { registerAgentTools } from '@guren/plugin-webmcp/client'
 *
 * await registerAgentTools(agentTools)
 * ```
 *
 * Progressive enhancement by construction: a browser with no `modelContext`
 * gets `{ supported: false }` and no exception, because this runs on every
 * page load of an app that adopts it and a missing experimental API is the
 * normal case, not an error. Registration failures are the opposite — see
 * the loop below.
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
      await anchor.registerTool({
        name: tool.toolName,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
        execute: (args, context) => executeTool(tool, args, context, options),
      })
    } catch (error) {
      // Propagated, not collected. A registration failure means the manifest
      // and the host disagree — a duplicate name, a schema the host rejects
      // — which is a wiring mistake the developer has to see; a page that
      // silently exposed nine of ten tools would look like it worked. The
      // ones already registered come back off first, so a caller that
      // catches and retries is not fighting a half-registered page.
      await unregisterAll(anchor, registered)
      throw error
    }
    registered.push(tool.toolName)
  }

  return {
    supported: true,
    registered,
    skipped,
    unregister: () => unregisterAll(anchor, registered),
  }
}

/**
 * Where the page publishes its model context.
 *
 * `document` first: the draft moved the anchor there, and
 * `navigator.modelContext` is the deprecated spelling (removed in Chrome
 * 150). Both are read through `globalThis` so this module stays importable —
 * and type-checkable — under SSR, where neither global exists. Nothing is
 * touched at module scope for the same reason.
 */
function resolveModelContext(override?: ModelContextLike): ModelContextLike | undefined {
  if (override) return override
  const scope = globalThis as {
    document?: { modelContext?: ModelContextLike }
    navigator?: { modelContext?: ModelContextLike }
  }
  return scope.document?.modelContext ?? scope.navigator?.modelContext
}

/** Best-effort removal; see {@link WebMcpRegistration.unregister}. */
async function unregisterAll(anchor: ModelContextLike, names: readonly string[]): Promise<void> {
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
 * response back into an MCP tool result.
 *
 * The two casts to `DerivedAgentTool` are the ones {@link WebMcpToolSource}
 * documents: the manifest is deeply readonly and the derivation's type is
 * not, while both functions here only read.
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
    // session cookie. Absent under SSR, where dispatch's own default applies
    // and this code does not run anyway.
    origin: (globalThis as { location?: { origin?: string } }).location?.origin,
    surface: 'webmcp',
  })

  // Wording matched to @guren/plugin-mcp's dispatch: one tool, two surfaces,
  // and an agent that reads a different diagnosis depending on which one it
  // reached would be debugging the client instead of its own call.
  if ('missing' in built) {
    return errorResult(`Missing required path parameter(s): ${built.missing.join(', ')}.`)
  }
  if ('invalidPath' in built) {
    return errorResult(
      `Path parameter(s) ${built.invalidPath.join(', ')} may not be "." or ".." — `
      + 'a dot-segment would resolve to a different route than the one authorized.',
    )
  }

  applyCsrfToken(built.request)

  // Bound through a wrapper rather than passed as a bare reference:
  // `globalThis.fetch` invoked detached throws "Illegal invocation" in a
  // browser.
  const dispatch = options.fetch ?? ((input: Request, init?: RequestInit) => globalThis.fetch(input, init))

  let response: Response
  try {
    response = await dispatch(built.request, { signal: context?.signal })
  } catch (error) {
    // Returned rather than thrown. A rejected `execute` reaches the agent as
    // a host-level failure whose message is flattened or dropped, so an
    // offline tab would report "tool failed" with nothing to act on; as a
    // result it reads like any other error the tool can answer with.
    return errorResult(`Request failed: ${describeError(error)}`)
  }

  return toWireResult(await mapToolResponse(derived, response))
}

/**
 * Copy the CSRF cookie into the header Guren's middleware reads, for the
 * methods it protects. Absent cookie, no header: the app may be running with
 * `csrf({ cookie: false })`, and inventing an empty token would turn a
 * working call into a 403.
 */
function applyCsrfToken(request: Request): void {
  if (CSRF_SAFE_METHODS.has(request.method.toUpperCase())) return
  const token = readXsrfToken()
  if (token) request.headers.set(XSRF_HEADER_NAME, token)
}

/**
 * Read the `XSRF-TOKEN` cookie issued by Guren's CSRF middleware.
 *
 * Reached through `globalThis` for the same reason the generated API client
 * does it: the module has to stay importable outside a browser.
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
 * The MCP-shaped subset of a dispatch outcome.
 *
 * `status` and `preflightVerdict` are dropped deliberately. They exist for
 * the App MCP endpoint's audit trail, which has a server to record into; a
 * WebMCP host has none, and hands whatever `execute` returns straight to the
 * agent. Returning the content array alone is also the intersection every
 * shipped WebMCP implementation accepts, while the CG draft's serialization
 * of arbitrary return values is the part still moving.
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
