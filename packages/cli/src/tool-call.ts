/**
 * `guren tool:call` — invoke one agent tool against the real application (RFC 0016 §6).
 *
 * No second dispatch path: `deriveAgentTools`, `buildToolRequest`, `app.fetch`,
 * `mapToolResponse` — the same calls `@guren/plugin-mcp` makes, so what this shows is
 * what an agent actually gets. Tools come from the *booted* app's `router.definitions()`,
 * not `listTools()`'s file scan, which misses routes registered at boot and includes
 * unmounted `modules/<name>/` on disk — hence no `--routes` flag. The call is recorded:
 * `'cli'` is one of RFC 0016 §5.2's four surfaces, via the emitter the app bound ({@link resolveAuditEmitter}).
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
 * Parse `--input` into the flat argument object a tool call is. The offending text is
 * quoted back on every refusal: shell quoting is what mangles these, so the value as it
 * *arrived* is the one piece of evidence that settles it.
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
 * Read `--as` as the user the call authenticates as. `user:42` and a bare `42` both work;
 * any other prefix is refused by name rather than treated as an opaque id, since
 * `admin:1` reads as a role selector. The id goes through the same {@link parseUserId}
 * `token:issue` uses, so `0042` and `42` stay the different ids they are.
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
 * Boot the application and hand back its route definitions and `fetch`. Structural and
 * optional all the way down: the user's app may resolve a `@guren/core` older than the
 * agent surface, and must land on the message below rather than a `TypeError`.
 */
async function loadAgentSurface(
  appRoot?: string,
): Promise<{
  definitions: RouteDefinition[]
  fetch: (request: Request) => Promise<Response>
  audit: AgentAuditEmitter | undefined
}> {
  // Booted, failing rather than warning: a tool dispatched into a half-booted app
  // reaches a route graph whose configuration never completed.
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
 * The application's own audit emitter, or `undefined` — an honest absence, not a degraded
 * mode: inventing one would write records the operator never asked for. Every step is
 * guarded because the app is the *user's*: `container` may be some other object, and one
 * resolving a failing factory **throws**, which would fail a tool call in order to record
 * it. A failure is warned about, since an operator expecting a trail must hear it is not.
 */
function resolveAuditEmitter(app: MaybeApplication): AgentAuditEmitter | undefined {
  const container = app.container
  if (typeof container?.has !== 'function' || typeof container.make !== 'function') return undefined

  try {
    if (!container.has(AGENT_AUDIT_BINDING)) return undefined
    const emitter = container.make<unknown>(AGENT_AUDIT_BINDING)
    if (typeof emitter !== 'function') {
      // Said out loud, unlike the absent binding above: something bound that cannot be
      // called asked for a trail and will not get it, yet logs the same empty result.
      consola.warn(
        `This application binds "${AGENT_AUDIT_BINDING}" to a ${typeof emitter} rather than a function, `
          + 'so this call is not being recorded. Bind what createAuditEmitter() returns.',
      )
      return undefined
    }
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
 * Who an audit record says this call acted as. `--as user:42` becomes
 * `{ kind: 'user', id: 42 }` and its absence `null`; collapsing both would make
 * impersonation indistinguishable from an anonymous call. `surface: 'cli'` carries the
 * standing fact that **no credential was verified**, so `abilities` is omitted rather than
 * sent empty; `kind: 'service'` names a bearer with no user, the opposite of what `--as` says.
 */
function auditPrincipal(actingAs: string | number | undefined): AgentPrincipal | null {
  return actingAs === undefined ? null : { kind: 'user', id: actingAs }
}

/**
 * The path a `Set-Cookie` is actually scoped to (RFC 6265 §5.2.4, §5.3). Three rules the
 * obvious reading gets wrong: the *last* `Path` wins, not the first; an empty or
 * non-absolute value is not a path and falls back to the default path of the setting
 * request (always `/` here, since priming requests `/`); attribute whitespace is not part
 * of the value.
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
 * Fetch a CSRF token pair the way a browser does, and hand back the headers that present
 * it. A dispatched tool call matches neither shape `createCsrfMiddleware` lets past (no
 * `Authorization: Bearer`, no cookies), so a mutating call into a default auth stack
 * answers `403 CSRF token mismatch` — about the transport, not the tool. Not a bypass: the
 * same round-trip a browser performs, and an app issuing no token gets no headers added.
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

    // Path is honoured because it is configurable (`cookieOptions.path`): presenting
    // *more* than a browser would is the direction that could turn a real CSRF
    // misconfiguration into a green run. Domain and Secure are fixed by the request never
    // leaving the process.
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
   * Derivation warnings for this tool alone: the rest belong to routes the caller did not
   * ask about, and burying the one line that concerns this call is how a warning stops
   * being read.
   */
  warnings: string[]
}

/**
 * Find the tool, build its request, send it, map the response. Separated from the
 * printing so the rules are testable against a hand-built route graph, with no app on disk.
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
     * The application's audit emitter, when it configured one. Passed in rather than
     * resolved here so the recording rules stay testable with no app on disk.
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
          // The names themselves, not a pointer at `tool:list`: the answer to "what did
          // I mistype" is the list.
          ? ` This app exposes: ${available.join(', ')}.`
          : ' This app exposes no agent tools — declare .agent() on a named route.'),
    )
  }

  const built = buildToolRequest(tool, options.args, {
    origin: DISPATCH_ORIGIN,
    preflight: options.preflight,
  })

  // Nothing is recorded for either refusal below — a deliberate divergence from the App
  // MCP endpoint, which records a synthetic 400 because its caller is a remote agent and
  // it has no channel to refuse outside a tool result. Here the caller reads the error,
  // the command exits non-zero, and no request was sent, so no status could honestly be
  // recorded. Do not "align" these without moving the refusal itself.
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

  // The span the App MCP endpoint measures: request out to response read back. The CSRF
  // priming is outside it on purpose — transport setup, not what the tool cost.
  const startedAt = performance.now()
  let outcome: ToolCallOutcome
  try {
    outcome = await mapToolResponse(tool, await fetch(new Request(request, { headers })))
  } catch (error) {
    // Reaching here means the dispatch itself broke, not the route. Still an invocation,
    // recorded before the rethrow with the status an unhandled throw would report — under
    // `--preflight` too, and under the real tool's name: with no answer to read, nothing
    // here can say the handler did not run.
    record(tool, options, 500, startedAt, false)
    throw error
  }

  // Read once, from the marker `mapToolResponse` took off the seam's response header (see
  // `readVerdict`). It also catches an unanswered `--preflight`: an app predating the seam
  // runs the call, and reporting that as a rehearsal would be a lie about a write.
  const verdict = options.preflight ? readVerdict(outcome) : undefined

  // Recorded *after* the verdict is read: the verdict decides which tool the record
  // names. An answered rehearsal goes down as `guren.preflight`, anything else as the
  // tool that actually executed. See `record`.
  record(tool, options, outcome.status, startedAt, verdict !== undefined)

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
 * Record one invocation, if the application configured somewhere to record it. **This
 * surface emits no `AgentToolDenied`, ever** — the four denial reasons each name an
 * adapter check it does not run. Arguments go through the called tool's
 * `.agent({ redact })` list. **A rehearsal is recorded under `guren.preflight`, never the
 * tool it rehearsed**, decided by the seam's response marker, not the flag ({@link readVerdict}).
 */
function record(
  tool: DerivedAgentTool,
  // Narrower than what `dispatchToolCall` holds, and deliberately so: these
  // three fields are the whole of what a record is made of.
  options: { args: Record<string, unknown>; actingAs?: string | number; audit?: AgentAuditEmitter },
  status: number,
  startedAt: number,
  rehearsed: boolean,
): void {
  // The meta-tool's argument shape on MCP — `{ tool, input }` — so one reader
  // parses `guren.preflight` records from either surface.
  const args = rehearsed ? { tool: tool.toolName, input: options.args } : options.args

  // Guarded at the call, not only at the resolution: `agent.audit` is a public binding an
  // application writes itself, so the bound value need not be what `createAuditEmitter`
  // returns, and by this point the tool's write has already happened. Failing here would
  // take the mutation, print nothing, and exit non-zero.
  try {
    options.audit?.(
      new AgentToolInvoked(
        auditPrincipal(options.actingAs),
        rehearsed ? PREFLIGHT_TOOL_NAME : tool.toolName,
        redactAgentArguments(args, tool.redact),
        status,
        Math.round(performance.now() - startedAt),
        'cli',
      ),
    )
  } catch (error) {
    consola.warn(
      'The agent audit emitter this application bound threw, so this call was not recorded: '
        + `${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * Whether the app answered a rehearsal, and with what. **The answer comes from
 * `outcome.preflightVerdict`, never from the body.** An app predating the seam runs a
 * `--preflight` call *for real*, and if that route's output carries a `preflight` field a
 * body test would read the write as a rehearsal — a route's output cannot set the header.
 * The body still supplies the verdict's contents, once the header has settled that it is one.
 */
export function readVerdict(outcome: ToolCallOutcome): Record<string, unknown> | undefined {
  if (outcome.preflightVerdict !== true) return undefined

  const text = outcome.content[0]?.text
  if (!text) return {}

  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Marked as a verdict but unreadable. The marker establishes that the handler did not
    // run, so the caller gets an empty verdict; `undefined` would file the call under the
    // rehearsed tool's name.
  }
  return {}
}

export async function runToolCall(options: ToolCallOptions): Promise<void> {
  const args = parseToolInput(options.input)
  const actingAs = options.as === undefined ? undefined : parseActingAs(options.as)

  if (actingAs !== undefined) {
    // `--as` rides `X-Testing-User`, which `attachAuthContext` honours only while
    // `GUREN_TESTING` is set, so it must be set here before the app is imported. Set
    // loudly and never by default: that header is the one thing standing between a
    // deployed app and unauthenticated impersonation. Never restored — this process exits
    // after the call, and the tests that import `runToolCall` restore it themselves.
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

  // The dispatch succeeded; the call failed. A script asking "did this tool work" must
  // not read a 422 as success, so the status sets the exit code — set, not thrown, so the
  // body still prints.
  if (result.outcome.isError) {
    process.exitCode = 1
  }
}

function printJson(result: ToolCallResult): void {
  // One JSON object on stdout and nothing beside it — warnings ride inside, since a
  // consola line would make the output unparseable for callers passing --json.
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
