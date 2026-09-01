/**
 * `guren tool:call` — invoke one agent tool against the real application
 * (RFC 0016 §6).
 *
 * There is no second dispatch path here. The command derives tools with
 * `deriveAgentTools`, rebuilds the HTTP request with `buildToolRequest`, sends
 * it through `app.fetch`, and reads the answer with `mapToolResponse` — the
 * same three calls `@guren/plugin-mcp` makes. A CLI that assembled its own
 * request would be a second, quieter adapter, and the first thing to drift
 * would be the one thing this command exists to show: what an agent actually
 * gets.
 *
 * **Where the tools come from.** The booted application's own
 * `router.definitions()`, not `listTools()`'s file scan. The two disagree in
 * both directions and either disagreement produces a tool this command can
 * name and then a 404 it cannot explain: the file scan misses routes a
 * provider or plugin registers at boot, and it *includes* every `modules/<name>/`
 * present on disk whether or not `createApp({ modules })` mounts it. After
 * `boot()` the app router is by construction the graph `app.fetch` dispatches
 * into, so naming a tool and calling it cannot come apart. That is also why
 * this command has no `--routes` flag while `tool:list` does: pointing at a
 * routes file could not change what the booted app serves, and a flag that
 * silently does not apply is worse than an absent one.
 *
 * **And the call is recorded.** `'cli'` is one of RFC 0016 §5.2's four
 * surfaces, and this command is the whole of it. A developer calling a write
 * tool here, as any user they like via `--as`, is exactly the event an audit
 * trail exists to hold — so a booted app that configured an audit sink gets a
 * record of it, through the emitter that app bound rather than one this
 * command built. See {@link resolveAuditEmitter}.
 */
import { consola } from 'consola'
import {
  AGENT_AUDIT_BINDING,
  AgentToolInvoked,
  buildToolRequest,
  deriveAgentTools,
  mapToolResponse,
  PREFLIGHT_TOOL_NAME,
  redactAgentArguments,
  type AgentAuditEmitter,
  type AgentPrincipal,
  type DerivedAgentTool,
  type RouteDefinition,
  type ToolCallOutcome,
} from '@guren/core'
import { loadBootedApplication, type MaybeApplication } from './runtime'
import { parseUserId } from './token-issue'

/** Origin the synthesized request is built on — never leaves the process. */
const DISPATCH_ORIGIN = 'http://localhost'

/** The only `--as` prefix there is a principal for. */
const ACTING_AS_PREFIX = 'user:'

/**
 * Methods a CSRF middleware verifies. Anything outside this set needs no
 * token, so the priming round-trip below is skipped for it.
 */
const CSRF_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export interface ToolCallOptions {
  /** Tool name, as `tool:list` prints it. */
  name: string
  /** Raw `--input` JSON text. Absent means no arguments. */
  input?: string
  /** Raw `--as` value: `user:42` or a bare id. */
  as?: string
  /** Ask for a verdict instead of an execution (RFC 0016 §5.4). */
  preflight?: boolean
  /** Application root directory. */
  appRoot?: string
  /** Emit one machine-readable JSON object instead of the human report. */
  json?: boolean
}

/**
 * Parse `--input` into the flat argument object a tool call is.
 *
 * The offending text is quoted back on every refusal. A JSON error alone
 * ("Unexpected token }") describes a string the user cannot see from here —
 * shell quoting is what mangles these, so the value as it *arrived* is the
 * one piece of evidence that settles it.
 */
export function parseToolInput(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined || raw.trim() === '') return {}

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `--input is not valid JSON: ${error instanceof Error ? error.message : String(error)}\n`
        + `  received: ${raw}\n`
        + '  Tool arguments are a flat JSON object, for example --input \'{"title":"Hello"}\'.',
    )
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `--input must be a JSON object, got ${Array.isArray(parsed) ? 'an array' : `a ${parsed === null ? 'null' : typeof parsed}`}.\n`
        + `  received: ${raw}\n`
        + '  A tool call is a flat object of arguments, for example --input \'{"title":"Hello"}\'.',
    )
  }

  return parsed as Record<string, unknown>
}

/**
 * Read `--as` as the user the call authenticates as.
 *
 * `user:42` and a bare `42` both work; any other prefix is refused by name
 * rather than treated as an opaque id, because `admin:1` reads as a role
 * selector and silently authenticating as a user literally called `admin:1`
 * is the confident wrong answer. The id itself goes through the same
 * {@link parseUserId} `token:issue` uses, so `0042` and `42` stay the
 * different ids they are.
 */
export function parseActingAs(raw: string): string | number {
  const value = raw.trim()
  if (value === '') {
    throw new Error('--as requires a user id, for example --as user:42.')
  }

  if (value.startsWith(ACTING_AS_PREFIX)) {
    const id = value.slice(ACTING_AS_PREFIX.length).trim()
    if (id === '') {
      throw new Error('--as user: requires an id after the prefix, for example --as user:42.')
    }
    return parseUserId(id)
  }

  const colon = value.indexOf(':')
  if (colon > 0) {
    throw new Error(
      `Unknown --as prefix "${value.slice(0, colon + 1)}". The only principal this flag names is a user: `
        + 'write --as user:42, or pass a bare id.',
    )
  }

  return parseUserId(value)
}

/** The `X-Testing-User` envelope `@guren/testing` sends, for one bare id. */
function testingUserHeader(userId: string | number): string {
  return JSON.stringify({ id: userId, __authId: userId })
}

/**
 * Boot the application and hand back its route definitions and `fetch`.
 *
 * Structural and optional all the way down, like `MaybeApplication` itself:
 * the app being loaded is the *user's*, and one resolving a `@guren/core`
 * older than the agent surface must land on the message below rather than on
 * a `TypeError` naming an internal.
 */
async function loadAgentSurface(
  appRoot?: string,
): Promise<{
  definitions: RouteDefinition[]
  fetch: (request: Request) => Promise<Response>
  audit: AgentAuditEmitter | undefined
}> {
  // Booted, and failing rather than warning if it cannot be: a tool dispatched
  // into a half-booted app reaches a route graph whose configuration never
  // completed.
  const app = await loadBootedApplication(appRoot)

  const definitions = app.router?.definitions?.()
  if (!definitions) {
    throw new Error(
      'This application exposes no route registry, so no agent tool can be derived from it. '
        + 'Upgrade @guren/core to a version with the agent interface (RFC 0016) and try again.',
    )
  }

  if (typeof app.fetch !== 'function') {
    throw new Error(
      'This application has no fetch() handler, so a tool call cannot re-enter it as an HTTP request.',
    )
  }

  const fetch = app.fetch.bind(app)
  return { definitions, fetch: async (request) => fetch(request), audit: resolveAuditEmitter(app) }
}

/**
 * The application's own audit emitter, or `undefined`.
 *
 * `undefined` covers every honest absence and is not a degraded mode: an app
 * with no MCP plugin, or one whose plugin was given no `audit` sink, has asked
 * for no trail, and this command inventing one would be a second audit
 * configuration the operator never wrote — writing records somewhere they do
 * not look, in a format they did not choose. The absence here is the same
 * absence the endpoint has.
 *
 * Every step is guarded, and that is the point rather than defensive padding.
 * The app is the *user's*: its `container` may be absent or some other object,
 * `has`/`make` may not be functions, `make` may hand back something that is not
 * one, and a container resolving a failing factory **throws**. Letting any of
 * those reach the caller would fail a tool call in order to record it — the
 * exact inversion the emitter itself is built to prevent, one layer up. A
 * failure is warned about rather than swallowed, for the reason a dropped
 * record always is: an operator who believes a trail is being written needs to
 * hear that it is not.
 */
function resolveAuditEmitter(app: MaybeApplication): AgentAuditEmitter | undefined {
  const container = app.container
  if (typeof container?.has !== 'function' || typeof container.make !== 'function') return undefined

  try {
    if (!container.has(AGENT_AUDIT_BINDING)) return undefined
    const emitter = container.make<unknown>(AGENT_AUDIT_BINDING)
    if (typeof emitter !== 'function') return undefined
    return emitter as AgentAuditEmitter
  } catch (error) {
    consola.warn(
      `This application binds an agent audit emitter that could not be resolved, so this call is not `
        + `being recorded: ${error instanceof Error ? error.message : String(error)}`,
    )
    return undefined
  }
}

/**
 * Who an audit record says this call acted as.
 *
 * `--as user:42` becomes `{ kind: 'user', id: 42 }` and its absence `null`,
 * which is the honest pair. Dropping to `null` for both would make a developer
 * impersonating user 42 indistinguishable from an anonymous call, and *who*
 * a write was performed as is the one fact a reader of this trail most needs.
 *
 * The two fields answer different questions and neither may be asked to carry
 * the other's. `principal` records who the application acted as; `surface:
 * 'cli'` carries the standing fact that **no credential was verified** — this
 * command authenticates with an injected `X-Testing-User` header, not a token
 * or a session, so every `'cli'` record is a developer-initiated call by
 * construction.
 *
 * `abilities` is therefore omitted rather than sent empty. Abilities are a
 * *token's*, and there was no token; `abilities: []` would read as "a token
 * that granted nothing", which is a claim about a credential that does not
 * exist.
 *
 * `kind: 'service'` is never right here: it names an App MCP bearer with no
 * user behind it, which is the opposite of what `--as` says.
 */
function auditPrincipal(actingAs: string | number | undefined): AgentPrincipal | null {
  return actingAs === undefined ? null : { kind: 'user', id: actingAs }
}

/**
 * The path a `Set-Cookie` is actually scoped to (RFC 6265 §5.2.4, §5.3).
 *
 * Three rules, each of which the obvious reading gets wrong in a direction
 * that matters here. The *last* `Path` wins, not the first — taking the first
 * of `Path=/; Path=/admin` sends a cookie a browser withholds. An empty or
 * non-absolute value is not a path at all and falls back to the default path
 * of the request that set it; since priming always requests `/`, that is `/`
 * — treating `path: 'admin'` as a scope instead withholds a cookie a browser
 * sends, and turns a working app into a 403 nobody can explain. Attribute
 * whitespace is not part of the value.
 */
function cookiePath(attributes: string[]): string {
  const declared = attributes
    .map((attribute) => attribute.trim())
    .filter((attribute) => attribute.toLowerCase().startsWith('path='))
    .at(-1)
    ?.slice('path='.length)
    .trim()

  return declared !== undefined && declared.startsWith('/') ? declared : '/'
}

/** RFC 6265 §5.1.4: does a cookie scoped to `cookiePath` travel to `requestPath`? */
function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (cookiePath === '' || cookiePath === '/') return true
  if (requestPath === cookiePath) return true
  if (!requestPath.startsWith(cookiePath)) return false
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/'
}

/**
 * Fetch a CSRF token pair the way a browser does, and hand back the headers
 * that present it.
 *
 * A dispatched tool call is neither of the two shapes `createCsrfMiddleware`
 * lets past: it carries no `Authorization: Bearer` (this command authenticates
 * with `--as`, not a token) and no cookies. So a mutating call into any app
 * with the default auth stack answers `403 CSRF token mismatch` — a refusal
 * about the transport, not about the tool, and the one the caller can do
 * nothing with. Priming is not a bypass: it performs exactly the round-trip a
 * browser performs, and an app that issues no token gets no headers added.
 */
async function primeCsrfHeaders(
  fetch: (request: Request) => Promise<Response>,
  toolPath: string,
): Promise<Record<string, string>> {
  let response: Response
  try {
    response = await fetch(new Request(`${DISPATCH_ORIGIN}/`, { method: 'GET' }))
  } catch {
    // The app refused a bare GET. Not this command's problem to diagnose —
    // the dispatch below reports whatever the real call answers.
    return {}
  }

  const cookies = new Map<string, string>()
  for (const setCookie of response.headers.getSetCookie()) {
    const [pair, ...attributes] = setCookie.split(';')
    const separator = pair?.indexOf('=') ?? -1
    if (!pair || separator <= 0) continue

    // Path is honoured because it is configurable (`cookieOptions.path`), so
    // ignoring it would let this command present a cookie a browser would
    // withhold — presenting *more* than a browser is the one direction that
    // could turn a real CSRF misconfiguration into a green run here. Domain
    // and Secure are not evaluated: the request never leaves the process and
    // both are fixed by that.
    if (!pathMatches(toolPath, cookiePath(attributes))) continue

    cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim())
  }

  const xsrf = cookies.get('XSRF-TOKEN')
  if (!xsrf) return {}

  return {
    Cookie: [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; '),
    'X-XSRF-TOKEN': decodeURIComponent(xsrf),
  }
}

export interface ToolCallResult {
  tool: DerivedAgentTool
  outcome: ToolCallOutcome
  /** The preflight verdict, when one was asked for and answered. */
  verdict?: Record<string, unknown>
  /** `--preflight` was asked for but the app ran the call instead. */
  preflightUnanswered: boolean
  /**
   * Derivation warnings for this tool alone, for the reason `tool:inspect`
   * gives: the rest belong to routes the caller did not ask about, and burying
   * the one line that concerns this call among them is how a warning stops
   * being read.
   */
  warnings: string[]
}

/**
 * Find the tool, build its request, send it, map the response.
 *
 * Separated from the printing below so the rules are testable against a
 * hand-built route graph, with no application on disk.
 */
export async function dispatchToolCall(
  definitions: readonly RouteDefinition[],
  fetch: (request: Request) => Promise<Response>,
  options: {
    name: string
    args: Record<string, unknown>
    actingAs?: string | number
    preflight?: boolean
    /**
     * The application's audit emitter, when it configured one. Passed in
     * rather than resolved here so the recording rules are testable against a
     * hand-built route graph, with no application on disk — the same reason
     * this function takes `definitions` and `fetch` instead of an app.
     */
    audit?: AgentAuditEmitter
  },
): Promise<ToolCallResult> {
  const { tools } = deriveAgentTools([...definitions])
  const tool = tools.find((candidate) => candidate.toolName === options.name)

  if (!tool) {
    const available = tools.map((candidate) => candidate.toolName).sort()
    throw new Error(
      `No agent tool named "${options.name}".`
        + (available.length > 0
          // The names themselves, not a pointer at `tool:list`: the answer to
          // "what did I mistype" is the list, and a second command to run is
          // a step between the question and it.
          ? ` This app exposes: ${available.join(', ')}.`
          : ' This app exposes no agent tools — declare .agent() on a named route.'),
    )
  }

  const built = buildToolRequest(tool, options.args, {
    origin: DISPATCH_ORIGIN,
    preflight: options.preflight,
  })

  // Nothing is recorded for either refusal below, and that is a deliberate
  // divergence from the App MCP endpoint, which answers both with a synthetic
  // 400 and records that as an invocation. The two surfaces are answering
  // different questions. There, the caller is a remote agent whose malformed
  // call is itself worth a line in the trail, and MCP has no channel to refuse
  // a call outside a tool result. Here the caller is the person reading the
  // error, the command exits non-zero, and no request was ever sent — so there
  // is no status a record could honestly carry, and the alternative would be
  // an invented one. Do not "align" these without moving the refusal itself.
  if ('missing' in built) {
    throw new Error(
      `--input is missing ${built.missing.length === 1 ? 'a path parameter' : 'path parameters'} `
        + `${tool.method} ${tool.path} requires: ${built.missing.join(', ')}.`,
    )
  }
  if ('invalidPath' in built) {
    throw new Error(
      `--input gives a URL dot-segment ("." or "..") for ${built.invalidPath.join(', ')}, which would `
        + `resolve to a different path than ${tool.path}. Pass a real value.`,
    )
  }

  const request = built.request
  const headers = new Headers(request.headers)
  if (options.actingAs !== undefined) {
    headers.set('X-Testing-User', testingUserHeader(options.actingAs))
  }
  if (!CSRF_SAFE_METHODS.has(tool.method)) {
    // The tool's own path, so a path-scoped cookie is judged against the
    // request that will actually carry it.
    const primed = await primeCsrfHeaders(fetch, new URL(request.url).pathname)
    for (const [name, value] of Object.entries(primed)) {
      headers.set(name, value)
    }
  }

  // The span the App MCP endpoint measures: the dispatch, from the request
  // going out to the response having been read back. The CSRF priming above is
  // outside it on purpose — that round trip is this surface's transport setup,
  // not part of what the tool cost, and including it would make every mutating
  // call here look slower than the same call over MCP for a reason that has
  // nothing to do with the tool.
  const startedAt = performance.now()
  let outcome: ToolCallOutcome
  try {
    outcome = await mapToolResponse(tool, await fetch(new Request(request, { headers })))
  } catch (error) {
    // The route's own failures came back as responses; reaching here means the
    // dispatch itself broke. Still an invocation — it ran — recorded with the
    // status the app would have reported for an unhandled throw, exactly as
    // the MCP endpoint records the same case. Recorded *before* the rethrow,
    // so the trail keeps a call whose error the caller is about to see. Under
    // `--preflight` too, and under the real tool's name: with no answer to
    // read, nothing here can say the handler did not run.
    record(options.audit, tool, options, 500, startedAt, false)
    throw error
  }

  // The verdict marker is a field of the body, not the response header the
  // seam sets: that header is deliberately not published API (see
  // `internal/agent-preflight.ts`), and the body says `preflight: true` for
  // exactly this reason. Reading it back also tells us when a `--preflight`
  // went unanswered — an app on a @guren/core predating the seam runs the
  // call, and reporting that as a rehearsal would be a lie about a write that
  // happened.
  const verdict = options.preflight ? readVerdict(outcome) : undefined

  // Recorded *after* the verdict is read, because the verdict is what decides
  // which tool the record names. A rehearsal that answered goes down as
  // `guren.preflight`; anything else — including a `--preflight` the app ran
  // anyway — goes down as the tool that actually executed. See `record`.
  record(options.audit, tool, options, outcome.status, startedAt, verdict !== undefined)

  return {
    tool,
    outcome,
    verdict,
    preflightUnanswered: Boolean(options.preflight) && verdict === undefined && !outcome.isError,
    // Only this tool's warnings — see `ToolCallResult.warnings`.
    warnings: tool.warnings,
  }
}

/**
 * Record one invocation, if the application configured somewhere to record it.
 *
 * **This surface emits no `AgentToolDenied`, ever.** The four denial reasons —
 * `auth`, `scope`, `approval`, `rate-limit` — each name a check an *adapter*
 * runs before synthesizing a request, and this command runs none of them: it
 * has no token to scope, no rate budget, and it dispatches directly. The two
 * refusals it does make (a missing path parameter, a dot-segment) are argument
 * errors that none of those four reasons describes, and inventing one would put
 * a word in the trail that means something else everywhere it appears. What the
 * application itself refuses — a 401, a 403 from a policy — arrives as a
 * response, and is an invocation carrying that status, exactly as on every
 * other surface.
 *
 * Note what this does *not* claim: an `approval: 'required'` tool genuinely
 * does execute from here, because the approval gate lives in the MCP adapter.
 * That is a gap in this surface, recorded honestly as the invocation it is,
 * and not something a denial event would close.
 *
 * Arguments go through the *called tool's* `redact` list, not a copy of one.
 * `.agent({ redact })` is where a route says which of its fields must never be
 * written down, and a surface that masked with anything else would be a second
 * rule producing masks a reader cannot tell from the real ones. That holds for
 * a rehearsal too: the checked tool's rules mask the payload it was checked
 * with, wherever in the record that payload sits.
 *
 * **A rehearsal is recorded under `guren.preflight`, never under the tool it
 * rehearsed**, which is the rule the App MCP endpoint already follows and the
 * one this surface most needs. `--preflight` runs the middleware and validates
 * the contract but stops before the handler, so a record naming `posts.destroy`
 * with status 200 would be indistinguishable from a destroy that happened. The
 * probed tool is not lost: it rides in the record's arguments, exactly as the
 * meta-tool's own arguments carry it on MCP.
 *
 * `rehearsed` is decided by the *answer*, not by the flag. A `--preflight`
 * against an application whose `@guren/core` predates the preflight seam runs
 * the call for real, and that write is recorded under the real tool — the
 * command warns about the same thing on stdout. Naming it a rehearsal because
 * the caller asked for one would be the trail lying about a write.
 */
function record(
  audit: AgentAuditEmitter | undefined,
  tool: DerivedAgentTool,
  options: { args: Record<string, unknown>; actingAs?: string | number },
  status: number,
  startedAt: number,
  rehearsed: boolean,
): void {
  // The meta-tool's argument shape on MCP — `{ tool, input }` — so one reader
  // parses `guren.preflight` records from either surface.
  const args = rehearsed ? { tool: tool.toolName, input: options.args } : options.args

  audit?.(
    new AgentToolInvoked(
      auditPrincipal(options.actingAs),
      rehearsed ? PREFLIGHT_TOOL_NAME : tool.toolName,
      redactAgentArguments(args, tool.redact),
      status,
      Math.round(performance.now() - startedAt),
      'cli',
    ),
  )
}

function readVerdict(outcome: ToolCallOutcome): Record<string, unknown> | undefined {
  if (outcome.isError) return undefined
  const text = outcome.content[0]?.text
  if (!text) return undefined

  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed !== null && typeof parsed === 'object' && (parsed as { preflight?: unknown }).preflight === true) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Not JSON; the app answered with the route's own output.
  }
  return undefined
}

export async function runToolCall(options: ToolCallOptions): Promise<void> {
  const args = parseToolInput(options.input)
  const actingAs = options.as === undefined ? undefined : parseActingAs(options.as)

  if (actingAs !== undefined) {
    // `--as` rides `X-Testing-User`, which `attachAuthContext` honours only
    // while `GUREN_TESTING` is set — so the flag cannot work without setting
    // it here, before the app is imported and booted. Set loudly and never by
    // default: this is the same trust boundary `guren console` sits on (anyone
    // who can run it can already execute code in this project), but the header
    // it turns on is the one thing standing between a deployed app and
    // unauthenticated impersonation, so a run that enables it says so.
    // Never restored: this is a one-shot CLI process that exits after the
    // call, and a restore would only matter to a caller importing
    // runToolCall into a longer-lived process — which the tests do, and
    // which is why they save and restore it themselves.
    process.env.GUREN_TESTING = '1'
    consola.warn(
      `--as user:${String(actingAs)} bypasses authentication: it sets GUREN_TESTING=1 for this process so the `
        + 'app accepts an injected user. Development only — never run it against a shared or production database.',
    )
  }

  const { definitions, fetch, audit } = await loadAgentSurface(options.appRoot)
  const result = await dispatchToolCall(definitions, fetch, {
    name: options.name,
    args,
    actingAs,
    preflight: options.preflight,
    audit,
  })

  if (options.json) {
    printJson(result)
  } else {
    printReport(result)
  }

  // The dispatch itself succeeded; what failed is the call. A script asking
  // "did this tool work" must not read a 422 as a success, so the status is
  // reflected in the exit code — set, not thrown, so the body still prints.
  if (result.outcome.isError) {
    process.exitCode = 1
  }
}

function printJson(result: ToolCallResult): void {
  // One JSON object on stdout and nothing beside it — warnings ride inside,
  // because a consola line next to it makes the output unparseable for
  // exactly the callers that pass this flag.
  const { tool, outcome, verdict } = result
  console.log(
    JSON.stringify(
      {
        tool: tool.toolName,
        method: tool.method,
        path: tool.path,
        status: outcome.status,
        isError: Boolean(outcome.isError),
        preflight: verdict ?? null,
        preflightUnanswered: result.preflightUnanswered,
        content: outcome.content.map((part) => part.text).join('\n'),
        structuredContent: outcome.structuredContent ?? null,
        warnings: result.warnings,
      },
      null,
      2,
    ),
  )
}

function printReport(result: ToolCallResult): void {
  const { tool, outcome, verdict } = result

  for (const warning of result.warnings) consola.warn(warning)

  console.log(`\x1b[1m${tool.toolName}\x1b[0m  ${tool.method} ${tool.path}`)
  console.log(`Status:   ${outcome.status}${outcome.isError ? ' (error)' : ''}`)

  if (verdict) {
    console.log('')
    console.log('\x1b[1mPreflight\x1b[0m  allowed (the handler did not run)')
    const validated = asStringList(verdict.validated)
    const unverified = asStringList(verdict.unverified)
    console.log(`Validated: ${validated.length > 0 ? validated.join(', ') : '(nothing to validate)'}`)
    console.log(`Unverified: ${unverified.length > 0 ? unverified.join(', ') : '(nothing)'}`)
    if (typeof verdict.message === 'string') {
      console.log('')
      console.log(verdict.message)
    }
    return
  }

  console.log('')
  console.log('\x1b[1mResult\x1b[0m')
  if (outcome.structuredContent) {
    console.log(JSON.stringify(outcome.structuredContent, null, 2))
  } else {
    console.log(prettifyContent(outcome.content.map((part) => part.text).join('\n')))
  }

  if (result.preflightUnanswered) {
    consola.warn(
      'This app answered --preflight with a real call rather than a verdict, so the handler ran. '
        + 'Its @guren/core predates the preflight seam (RFC 0016 §5.4) — upgrade it before relying on rehearsals.',
    )
  }
}

/** JSON bodies read better indented; anything else is printed verbatim. */
function prettifyContent(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text) as unknown, null, 2)
  } catch {
    return text
  }
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}
