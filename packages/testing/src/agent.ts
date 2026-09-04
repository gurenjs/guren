/**
 * Agent tool calls in tests (RFC 0016 §6).
 *
 * Goes through the framework's own dispatch contract (`deriveAgentTools`,
 * `buildToolRequest`, `mapToolResponse`) and out through the same `fetch` every
 * other `TestApp` request uses; nothing here re-implements any of it, or a test
 * would pass while the tool an agent actually sees did something else.
 */
import type { DerivedAgentTool, RouteDefinition, ToolCallOutcome } from '@guren/server'

/**
 * What a tool dispatch needs from the `TestApp` it belongs to. `routeDefinitions`
 * answers `undefined` (not an empty list) for a `TestApp` built from a bare
 * `fetch`, so {@link TestAgent} can name the constructor to use instead.
 */
export interface AgentTestBridge {
  routeDefinitions(): readonly RouteDefinition[] | undefined
  /** Origin the synthesized request is built on — the app's own `baseUrl`. */
  baseUrl: string
  /** Headers this `TestApp` sends on every request, `X-Testing-User` included. */
  headers(): Record<string, string>
  dispatch(request: Request): Promise<Response>
  /** A bridge for the same app authenticating as `user` — see `TestApp.actingAs`. */
  actingAs(user: unknown): AgentTestBridge
}

/** The three dispatch functions plus the predicate that reads a result. */
interface AgentRuntime {
  deriveAgentTools(definitions: RouteDefinition[]): { tools: DerivedAgentTool[]; warnings: string[] }
  buildToolRequest(
    tool: DerivedAgentTool,
    args: Record<string, unknown>,
    options?: { origin?: string; preflight?: boolean },
  ): { request: Request } | { missing: string[] } | { invalidPath: string[] }
  mapToolResponse(tool: DerivedAgentTool, response: Response): Promise<ToolCallOutcome>
  advertisesStructuredOutput(tool: DerivedAgentTool): boolean
}

let runtimePromise: Promise<AgentRuntime> | undefined

/**
 * `@guren/core` is an *optional* peer, so the import can fail — or succeed against
 * a version predating the agent interface, leaving every name `undefined` and
 * throwing a `TypeError` at call time. Hence the symbols are checked, not assumed.
 */
async function loadAgentRuntime(): Promise<AgentRuntime> {
  runtimePromise ??= (async () => {
    let loaded: Partial<AgentRuntime> | undefined
    try {
      loaded = (await import('@guren/core')) as Partial<AgentRuntime>
    } catch {
      try {
        loaded = (await import('@guren/server')) as Partial<AgentRuntime>
      } catch {
        throw new Error(
          'agent() needs the Guren framework installed: neither @guren/core nor @guren/server could be imported.',
        )
      }
    }

    const missing = (['deriveAgentTools', 'buildToolRequest', 'mapToolResponse', 'advertisesStructuredOutput'] as const)
      .filter((name) => typeof loaded?.[name] !== 'function')

    if (missing.length > 0) {
      throw new Error(
        // Names the capability, not a version number: which release first carries
        // these exports is decided by `changeset version`.
        `The installed @guren/core predates the agent dispatch contract (missing ${missing.join(', ')}). `
          + 'agent() needs a @guren/core with the agent interface (RFC 0016) — upgrade it and try again.',
      )
    }

    return loaded as AgentRuntime
  })()

  return runtimePromise
}

/** Options for one tool call. */
export interface AgentCallOptions {
  /**
   * Authenticate the call as this user, exactly as `TestApp.actingAs(user)` does.
   * No token is involved, so bearer scopes are not part of this surface.
   */
  as?: unknown
  /**
   * Ask for a verdict instead of an execution (RFC 0016 §5.4): the request runs the
   * route's middleware and validates the contract, then stops before the handler.
   * MCP reaches the same seam through the `guren.preflight` companion tool instead.
   */
  preflight?: boolean
}

/**
 * The result of one tool call. Assertions here are synchronous;
 * {@link PendingAgentToolResult} carries the chainable spellings.
 */
export class AgentToolResult {
  constructor(
    /** The derived tool this call dispatched to. */
    readonly tool: DerivedAgentTool,
    /** The mapped outcome: content, structured content, error flag, status. */
    readonly outcome: ToolCallOutcome,
    /** The raw HTTP response, for assertions this class does not cover. */
    readonly response: Response,
    private readonly advertisesStructuredOutput: (tool: DerivedAgentTool) => boolean,
  ) {}

  /** The HTTP status the dispatch resolved to. */
  get status(): number {
    return this.outcome.status
  }

  /** True when the call came back as an MCP error result (4xx/5xx, mostly). */
  get isError(): boolean {
    return Boolean(this.outcome.isError)
  }

  /** Every text part of the result, joined — what an agent would read. */
  get text(): string {
    return this.outcome.content.map((part) => part.text).join('\n')
  }

  /** The structured result, when the tool advertises an object output schema. */
  get structuredContent(): Record<string, unknown> | undefined {
    return this.outcome.structuredContent
  }

  assertStatus(code: number): this {
    if (this.status !== code) {
      throw new Error(
        `Expected tool "${this.tool.toolName}" to answer ${code}, got ${this.status}: ${truncate(this.text)}`,
      )
    }
    return this
  }

  /**
   * Assert the call succeeded — not an error result. Deliberately not
   * `assertStatus(200)` (which is what `PendingTestResponse.assertOk()` means): a
   * 201 or 204 is a success, and MCP models the outcome as a boolean `isError`.
   */
  assertOk(): this {
    if (this.isError) {
      throw new Error(
        `Expected tool "${this.tool.toolName}" to succeed, got HTTP ${this.status}: ${truncate(this.text)}`,
      )
    }
    return this
  }

  /**
   * Assert the application answered 401 or 403. Not a scope denial: this surface
   * carries no bearer token, so assert scopes against the App MCP plugin's gate.
   *
   * A CSRF 403 is indistinguishable from a policy 403 — dispatch through
   * `(await app.withCsrf()).agent()` or this can pass with no policy consulted.
   */
  assertDenied(): this {
    if (this.status !== 401 && this.status !== 403) {
      throw new Error(
        `Expected tool "${this.tool.toolName}" to be denied (401 or 403), got ${this.status}: ${truncate(this.text)}`,
      )
    }
    return this
  }

  /**
   * Assert the call produced a structured result, and return it typed. The type
   * parameter is the author's assertion; the route's `output` schema is the check.
   */
  assertStructured<T = Record<string, unknown>>(): T {
    if (!this.advertisesStructuredOutput(this.tool)) {
      throw new Error(
        `Tool "${this.tool.toolName}" advertises no object output schema, so it can never return structured `
          + 'content. Bind an `output` schema to the route (a Zod object) to make its result structured.',
      )
    }
    if (!this.outcome.structuredContent) {
      throw new Error(
        `Expected tool "${this.tool.toolName}" to return structured content, got HTTP ${this.status}: `
          + truncate(this.text),
      )
    }
    return this.outcome.structuredContent as T
  }

  /** The result body parsed as JSON — for a tool with no output schema. */
  json<T = unknown>(): T {
    try {
      return JSON.parse(this.text) as T
    } catch {
      throw new Error(
        `Tool "${this.tool.toolName}" did not answer with JSON (HTTP ${this.status}): ${truncate(this.text)}`,
      )
    }
  }
}

/** A promise-like {@link AgentToolResult}, so assertions chain on the call. */
export class PendingAgentToolResult implements PromiseLike<AgentToolResult> {
  constructor(private readonly promise: Promise<AgentToolResult>) {}

  then<TResult1 = AgentToolResult, TResult2 = never>(
    onfulfilled?: ((value: AgentToolResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.promise.then(onfulfilled, onrejected)
  }

  private chain(assert: (result: AgentToolResult) => void): PendingAgentToolResult {
    return new PendingAgentToolResult(
      this.promise.then((result) => {
        assert(result)
        return result
      }),
    )
  }

  assertStatus(code: number): PendingAgentToolResult {
    return this.chain((result) => result.assertStatus(code))
  }

  assertOk(): PendingAgentToolResult {
    return this.chain((result) => result.assertOk())
  }

  assertDenied(): PendingAgentToolResult {
    return this.chain((result) => result.assertDenied())
  }

  /**
   * Chainable form of {@link AgentToolResult.assertStructured}: returns the pending
   * result, not the payload. `await` the call to get the value.
   */
  assertStructured(): PendingAgentToolResult {
    return this.chain((result) => result.assertStructured())
  }
}

/** The agent surface of a `TestApp` — reached through `app.agent()`. */
export class TestAgent {
  constructor(private readonly bridge: AgentTestBridge) {}

  /** Every tool this app exposes, as an agent would see them. */
  async tools(): Promise<DerivedAgentTool[]> {
    const { deriveAgentTools } = await loadAgentRuntime()
    return deriveAgentTools([...this.requireDefinitions()]).tools
  }

  /** Call one tool by name, with a flat argument object. */
  call(
    name: string,
    input: Record<string, unknown> = {},
    options: AgentCallOptions = {},
  ): PendingAgentToolResult {
    return new PendingAgentToolResult(this.dispatch(name, input, options))
  }

  private requireDefinitions(): readonly RouteDefinition[] {
    const definitions = this.bridge.routeDefinitions()
    if (!definitions) {
      throw new Error(
        'This TestApp has no route registry, so no agent tool can be derived from it. '
          + 'agent() needs an app whose routes it can see: build it with TestApp.create({ routes }) or '
          + 'TestApp.fromApp(app). TestApp.fromFetch()/fromWorkers() are handed a bare fetch function, '
          + 'which carries no route definitions.',
      )
    }
    return definitions
  }

  private async dispatch(
    name: string,
    input: Record<string, unknown>,
    options: AgentCallOptions,
  ): Promise<AgentToolResult> {
    const runtime = await loadAgentRuntime()
    const definitions = this.requireDefinitions()

    const { tools } = runtime.deriveAgentTools([...definitions])
    const tool = tools.find((candidate) => candidate.toolName === name)
    if (!tool) {
      const available = tools.map((candidate) => candidate.toolName).sort()
      throw new Error(
        `No agent tool named "${name}".`
          + (available.length > 0
            ? ` This app exposes: ${available.join(', ')}.`
            : ' This app exposes no agent tools — declare .agent() on a named route.'),
      )
    }

    // Routed through `TestApp.actingAs` rather than spelling the `X-Testing-User`
    // envelope a second time. Order matters: the tool was derived above from *this*
    // bridge, so `{ as }` works even on a copy that lost its route definitions.
    const bridge = options.as === undefined ? this.bridge : this.bridge.actingAs(options.as)

    const built = runtime.buildToolRequest(tool, input, {
      // The app's own baseUrl, not the dispatch default: `fromWorkers`/`fromApp` may
      // serve another origin, and host authorization reads the Host header this sets.
      origin: bridge.baseUrl,
      preflight: options.preflight,
    })

    if ('missing' in built) {
      throw new Error(
        `Tool "${name}" needs path parameter${built.missing.length === 1 ? '' : 's'} `
          + `${built.missing.join(', ')} for ${tool.method} ${tool.path}, which the input did not supply.`,
      )
    }
    if ('invalidPath' in built) {
      throw new Error(
        `Tool "${name}" was given a URL dot-segment ("." or "..") for ${built.invalidPath.join(', ')}, `
          + `which would resolve to a different path than ${tool.path}.`,
      )
    }

    // The app's standing headers underneath, the dispatch's on top: the dispatch
    // headers describe the tool call and must win, while the `X-Testing-User`
    // envelope and the `Cookie` + `X-XSRF-TOKEN` pair from `withCsrf()` must
    // survive, or a mutating call is refused by CSRF before any policy runs.
    const headers = new Headers(bridge.headers())
    built.request.headers.forEach((value, key) => headers.set(key, value))

    const response = await bridge.dispatch(new Request(built.request, { headers }))
    const outcome = await runtime.mapToolResponse(tool, response.clone())

    return new AgentToolResult(tool, outcome, response, runtime.advertisesStructuredOutput)
  }
}

function truncate(text: string, limit = 500): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}
