/**
 * Agent tool calls in tests (RFC 0016 §6).
 *
 * `app.agent().call('posts.store', { title: 'x' })` goes through the framework's
 * own dispatch contract — `deriveAgentTools` to find the tool, `buildToolRequest`
 * to rebuild the HTTP request, `mapToolResponse` to read the answer — and then
 * out through the same `fetch` every other `TestApp` request uses. Nothing here
 * re-implements any of it. A test that asserted against a hand-built request
 * would pass while the tool an agent actually sees did something else, which is
 * the one failure this helper exists to prevent.
 *
 * The seam is deliberately narrow: this module knows how to *dispatch* a tool,
 * and {@link AgentTestBridge} is everything it needs from a `TestApp` to do it.
 */
import type { DerivedAgentTool, RouteDefinition, ToolCallOutcome } from '@guren/server'

/**
 * What a tool dispatch needs from the `TestApp` it belongs to.
 *
 * `routeDefinitions` is the load-bearing one: a tool is derived from the app's
 * route graph, and a `TestApp` built from a bare `fetch` function has no graph
 * to derive from. It answers `undefined` there rather than an empty list, so
 * {@link TestAgent} can say which constructor to use instead of reporting that
 * the app exposes no tools.
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
 * Load the dispatch contract from whichever framework package is installed.
 *
 * `@guren/core` is an *optional* peer of this package, so the import can
 * legitimately fail — and, more quietly, can succeed against a version
 * predating the agent interface, leaving every destructured name `undefined`
 * and producing a `TypeError` at call time. The symbols are therefore checked,
 * not assumed: an unavailable capability has to say it is unavailable.
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
        // The capability, not a version number: which release first carries
        // these exports is decided by `changeset version`, and a minimum
        // guessed here would be a confident wrong answer in a user-facing
        // error.
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
   * Authenticate the call as this user, exactly as `TestApp.actingAs(user)`
   * does — the `X-Testing-User` envelope, honoured only while `GUREN_TESTING`
   * is set (which every `TestApp` constructor sets). There is no token here:
   * `@guren/testing` has no issuer, so bearer scopes are not part of this
   * surface.
   */
  as?: unknown
  /**
   * Ask for a verdict instead of an execution (RFC 0016 §5.4): the request runs
   * the route's middleware and validates the advertised contract, then stops
   * before the handler.
   *
   * MCP does not offer preflight at all — a tool that advertises an
   * `outputSchema` must answer with conforming `structuredContent`, and a
   * verdict conforms to no route's output. This surface is not bound by that
   * rule, so it offers what the seam supports.
   */
  preflight?: boolean
}

/**
 * The result of one tool call, as the agent surface produced it.
 *
 * Assertions are synchronous, matching the awaited half of
 * `PendingTestResponse`; {@link PendingAgentToolResult} carries the chainable
 * spellings.
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
   * Assert the call succeeded — not an error result.
   *
   * Deliberately not `assertStatus(200)` — which is what
   * `PendingTestResponse.assertOk()` means, and the divergence is on purpose.
   * A tool call is whatever the route answers: a `store` returning 201 and a
   * `destroy` returning 204 are successes, and MCP's own result model is a
   * boolean `isError` rather than a status. Use `assertStatus` when the exact
   * code is the point.
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
   * Assert the call was refused, and hand back the refusal.
   *
   * "Refused" means **the application answered 401 or 403** — its own
   * authentication or authorization. It is not a scope denial: scopes are a
   * property of the bearer token the App MCP plugin verifies, and this surface
   * carries no token (it authenticates by session or `actingAs`), so an
   * ungranted scope is unreachable from a test. Assert scope behaviour against
   * the plugin's gate instead.
   *
   * One caveat worth knowing: a 403 from the CSRF middleware is
   * indistinguishable from a 403 from a policy. Dispatch through
   * `(await app.withCsrf()).agent()` — or against an app that mounts no CSRF —
   * or this assertion can pass without a policy ever being consulted.
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
   * Assert the call produced a structured result, and return it typed.
   *
   * The type parameter is an assertion by the test author, not a check: the
   * shape is validated by the route's own `output` schema at runtime, which is
   * the same schema the tool advertises.
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

/**
 * A promise-like {@link AgentToolResult} that allows chaining assertions
 * directly on the call, mirroring `PendingTestResponse`:
 *
 * ```ts
 * await app.agent().call('posts.index').assertOk()
 * ```
 */
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
   * Chainable form of {@link AgentToolResult.assertStructured}. It returns the
   * pending result rather than the structured payload — `await` the call and
   * use the awaited `assertStructured<T>()` when you want the value.
   */
  assertStructured(): PendingAgentToolResult {
    return this.chain((result) => result.assertStructured())
  }
}

/**
 * The agent surface of a `TestApp` — reached through `app.agent()`.
 */
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

    // The bridge for the principal this call authenticates as. Routed through
    // `TestApp.actingAs` rather than spelling the `X-Testing-User` envelope a
    // second time: two spellings of that envelope is how they drift.
    //
    // Note the order: the tool was derived above from *this* bridge, and the
    // acting-as copy is used only for headers and dispatch. That is why `{ as }`
    // works even on a copy that lost its route definitions — a real hazard for
    // `app.actingAs(user).agent()`, which is why `TestApp.clone()` carries them.
    const bridge = options.as === undefined ? this.bridge : this.bridge.actingAs(options.as)

    const built = runtime.buildToolRequest(tool, input, {
      // The app's own baseUrl, not the dispatch default: a TestApp created by
      // `fromWorkers`/`fromApp` may serve a different origin, and host
      // authorization reads the Host header this sets.
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

    // The app's standing headers underneath, the dispatch's on top: `Accept`,
    // `Content-Type` and `X-Guren-Agent-Surface` describe the tool call and
    // must win, while everything the TestApp was configured with — the
    // `X-Testing-User` envelope, and the `Cookie` + `X-XSRF-TOKEN` pair
    // `withCsrf()` parks there — has to survive, or a mutating tool call is
    // refused by CSRF before any policy is consulted.
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
