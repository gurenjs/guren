/**
 * The dispatch contract (RFC 0016 §3): a tool call re-enters the application as
 * a real HTTP request, so validation, policies and middleware run exactly once,
 * in the app. Pure request/response plumbing — it never validates arguments and
 * never decides authorization.
 */
import type { AgentToolInputSource, DerivedAgentTool } from './derive'
import type { AgentSurface } from './events'
import { PATH_PARAM_PATTERN } from '../internal/route-path'
import { AGENT_PREFLIGHT_HEADER, AGENT_PREFLIGHT_VERDICT_HEADER } from '../internal/agent-preflight'

/** How many characters of a non-JSON response body survive into the result. */
const TEXT_RESPONSE_CAP = 50_000

export interface BuildToolRequestOptions {
  /**
   * Origin the synthesized URL is built on. Never leaves the process — the
   * request goes straight into `app.fetch` — but host-authorization
   * middleware still reads its `Host`, so the default stays on the one name
   * every dev allowlist admits.
   */
  origin?: string
  /**
   * `Authorization` header to forward verbatim, so the app's own token guard
   * authenticates the same principal the adapter verified. Absent for a
   * surface that authenticates some other way.
   */
  authorization?: string
  /**
   * Ask for a verdict instead of an execution (RFC 0016 §5.4): the request
   * runs the route's middleware and validates the advertised contract, then
   * stops before the handler. Only routes declaring `.agent()` honour it.
   */
  preflight?: boolean
  /**
   * Which protocol surface the call arrived on, announced as
   * `X-Guren-Agent-Surface`; defaults to `'mcp'`. Informational and write-only
   * here — it borrows the audit trail's vocabulary ({@link AgentSurface}), but
   * the trail's own `surface` comes from the adapter. Nothing may authorize on
   * it: any client sets any header it likes.
   */
  surface?: AgentSurface
}

/**
 * The argument-level spelling of a preflight request (RFC 0016 §5.4), for a
 * surface whose callers pass flat arguments rather than dispatch options. No
 * adapter accepts it today — every surface asks through
 * `BuildToolRequestOptions.preflight`. A surface adopting it owns the stripping:
 * it is an instruction to the adapter, not a field of any route's contract.
 */
export const PREFLIGHT_ARGUMENT = '_preflight'

export type BuiltToolRequest =
  | { request: Request }
  | ToolRequestBuildFailure

/** The ways `buildToolRequest` refuses to build — no HTTP has happened. */
export type ToolRequestBuildFailure =
  /** Path parameters the call did not supply — the URL cannot be built. */
  | { missing: string[] }
  /**
   * Path parameter values that are URL dot-segments (`.` / `..`). Rejected,
   * never substituted: `encodeURIComponent` leaves a dot untouched and the URL
   * parser then collapses the segment, so `{ name: '..' }` on `/files/:name/meta`
   * would reach `/meta`, a route the scope check never saw. `.` and `..` are
   * the only ASCII segments the WHATWG parser normalizes, so this set is complete.
   */
  | { invalidPath: string[] }

/**
 * The agent-facing diagnosis of a {@link ToolRequestBuildFailure}. One function
 * rather than a string per adapter: the same tool is reachable from several
 * surfaces, and a diagnosis that varied by surface would have an agent
 * debugging the client instead of its own call.
 */
export function describeBuildFailure(failure: ToolRequestBuildFailure): string {
  if ('missing' in failure) {
    return `Missing required path parameter(s): ${failure.missing.join(', ')}.`
  }
  return (
    `Path parameter(s) ${failure.invalidPath.join(', ')} may not be "." or ".." — `
    + 'a dot-segment would resolve to a different route than the one authorized.'
  )
}

/**
 * Rebuild the HTTP request a tool call describes. The flat argument object is
 * taken apart along `tool.inputSources`, so a POST route's `query` keys land
 * where `validateQuery` reads them; unadvertised keys are forwarded for the
 * route's validator to reject. GET and HEAD force everything into the query
 * string: `Request` refuses a body there, and a GET `body` schema is a defect.
 */
export function buildToolRequest(
  tool: DerivedAgentTool,
  args: Record<string, unknown>,
  options: BuildToolRequestOptions = {},
): BuiltToolRequest {
  const origin = options.origin ?? 'http://localhost'
  const missing: string[] = []
  const invalidPath: string[] = []
  // Path parameters consumed *exclusively* by the URL. A name the merge
  // resolved to `query`/`body` fills the path and still flows to its declared
  // sink below, so it is not added here.
  const pathOnly = new Set<string>()

  // The one path lexer (PATH_PARAM_PATTERN) does the substitution, so the names
  // replaced here are exactly the ones the derivation advertised — `:name*` is
  // a parameter literally named `name*` on both sides.
  const path = tool.path.replace(
    PATH_PARAM_PATTERN,
    (_match, lead: string, name: string) => {
      const value = args[name]
      if (value === undefined) {
        missing.push(name)
        return `${lead}:${name}`
      }
      // The raw stringified value — the dot-segment check runs before
      // encoding, because `encodeURIComponent` leaves `.`/`..` untouched.
      const stringified = String(value)
      if (stringified === '.' || stringified === '..') {
        invalidPath.push(name)
        return `${lead}:${name}`
      }
      // A name the merge assigned to query/body still substitutes into the URL
      // but keeps flowing to that sink, so a collision does not drop the
      // argument from the body the route validates.
      const source = sourceOf(tool, name)
      if (source === undefined || source === 'params' || source === 'path') {
        pathOnly.add(name)
      }
      return `${lead}${encodeURIComponent(stringified)}`
    },
  )
  if (missing.length > 0) {
    return { missing }
  }
  if (invalidPath.length > 0) {
    return { invalidPath }
  }

  const method = tool.method
  const bodyless = method === 'GET' || method === 'HEAD'

  const query = new URLSearchParams()
  const bodyEntries: Array<[string, unknown]> = []
  for (const [key, value] of Object.entries(args)) {
    if (pathOnly.has(key) || value === undefined) continue
    const source = sourceOf(tool, key)
    // Query-bound: everything on a bodyless method; declared `query` keys; a
    // `params`/`path` key the path never declared (forwarded so the route's
    // validation reports the defect rather than it vanishing here); and, on a
    // nested-body route, any key that is not the body itself, since that body
    // is `args.body` verbatim and has no object to absorb strays.
    const toQuery = bodyless
      || source === 'query'
      || source === 'params'
      || source === 'path'
      || (tool.inputBodyNested && key !== 'body')

    if (toQuery) {
      appendQueryValue(query, key, value)
    } else {
      bodyEntries.push([key, value])
    }
  }

  const headers = new Headers({
    // What turns an Inertia route into page JSON instead of an HTML document,
    // without engaging the `X-Inertia` visit protocol and its 409 version
    // negotiation, which a stateless tool call has no version to answer.
    Accept: 'application/json',
    'X-Guren-Agent-Surface': options.surface ?? 'mcp',
  })
  if (options.authorization) {
    headers.set('Authorization', options.authorization)
  }
  if (options.preflight) {
    headers.set(AGENT_PREFLIGHT_HEADER, '1')
  }

  let body: string | undefined
  if (!bodyless) {
    if (tool.inputBodyNested) {
      // The route validates a non-object body, which the derivation nested
      // under `body` to give the tool an object root. Unwrapped here: posting
      // `{ body: [...] }` would hand the validator an object.
      if (Object.hasOwn(args, 'body')) {
        body = JSON.stringify(args.body)
      }
    } else if (bodyEntries.length > 0) {
      body = JSON.stringify(accumulate(bodyEntries))
    }
  }
  if (body !== undefined) {
    headers.set('Content-Type', 'application/json')
  }

  const qs = query.toString()
  const url = `${origin}${path}${qs ? `?${qs}` : ''}`
  return { request: new Request(url, { method, headers, body }) }
}

/**
 * The contract a property was declared under, or undefined if the derivation
 * never advertised it. `Object.hasOwn` rather than a plain read: a JSON
 * argument may legally be named `__proto__`, and `inputSources['__proto__']`
 * would otherwise resolve to `Object.prototype`, not undefined.
 */
function sourceOf(tool: DerivedAgentTool, name: string): AgentToolInputSource | undefined {
  return Object.hasOwn(tool.inputSources, name) ? tool.inputSources[name] : undefined
}

/** Primitives stringify; anything structured rides as JSON text. */
function appendQueryValue(query: URLSearchParams, key: string, value: unknown): void {
  if (Array.isArray(value)) {
    for (const element of value) {
      query.append(key, serializeQueryScalar(element))
    }
    return
  }
  query.append(key, serializeQueryScalar(value))
}

function serializeQueryScalar(value: unknown): string {
  if (value === null || typeof value !== 'object') return String(value)
  return JSON.stringify(value)
}

/**
 * Null-prototype accumulator, spread back to plain: a JSON argument may
 * legally be named `__proto__`, and assigning that key on `{}` invokes the
 * prototype setter instead of defining the property — the same rule the
 * derivation and the redaction walk apply.
 */
function accumulate(entries: Array<[string, unknown]>): Record<string, unknown> {
  const record = Object.create(null) as Record<string, unknown>
  for (const [key, value] of entries) {
    record[key] = value
  }
  return { ...record }
}

/** An MCP tool result, shaped for the SDK's CallToolResult. */
export interface ToolCallOutcome {
  content: Array<{ type: 'text'; text: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
  /** The HTTP status the dispatch resolved to, for the audit event. */
  status: number
  /**
   * The response carried the preflight verdict header, so this is the seam's
   * answer and not the route's own output. Carried here because
   * `mapToolResponse` is the only place that sees the header; a caller
   * re-deriving it from a `preflight` field in the body would read an ordinary
   * route as a rehearsal that never ran.
   */
  preflightVerdict?: boolean
}

/**
 * Whether the tool advertises an object output schema — the only kind MCP
 * lists, and so the only kind obliging a success result to carry
 * `structuredContent`. `describeTool` and `mapToolResponse` must agree on this
 * exact predicate, or one advertises a schema the other cannot satisfy.
 */
export function advertisesStructuredOutput(tool: DerivedAgentTool): boolean {
  return tool.outputSchema?.type === 'object'
}

/**
 * Map the application's response onto an MCP tool result (RFC 0016 §3.4): 2xx
 * JSON → text (+ `structuredContent` for an object `outputSchema`); Inertia page
 * JSON → `page.props`; 204/3xx → status line, not an error; 4xx/5xx → `isError`
 * with the handler's body; other → capped text. An object-`outputSchema` success
 * lacking an object becomes `isError`: the SDK client rejects it after the route ran.
 */
export async function mapToolResponse(
  tool: DerivedAgentTool,
  response: Response,
): Promise<ToolCallOutcome> {
  const status = response.status
  const structured = advertisesStructuredOutput(tool)

  if (status === 204 || (status >= 300 && status < 400)) {
    const location = response.headers.get('Location')
    const text = location ? `HTTP ${status} (Location: ${location})` : `HTTP ${status}`
    if (structured) return inconsistentOutput(tool, text, status)
    return { content: [{ type: 'text', text }], status }
  }

  const raw = await response.text()

  if (status >= 400) {
    return {
      content: [{ type: 'text', text: raw || `HTTP ${status}` }],
      isError: true,
      status,
    }
  }

  // Parsed only past the error branch, which reads the raw body verbatim.
  const parsed = parseJsonBody(response, raw)

  if (parsed === undefined) {
    const text = raw.length > TEXT_RESPONSE_CAP
      ? `${raw.slice(0, TEXT_RESPONSE_CAP)}… [truncated ${raw.length - TEXT_RESPONSE_CAP} characters]`
      : raw
    if (structured) return inconsistentOutput(tool, `a non-JSON body (${text.slice(0, 200)})`, status)
    return { content: [{ type: 'text', text }], status }
  }

  // A preflight verdict is not the route's output: the handler never ran. Put
  // in `structuredContent`, an SDK client would validate it against the tool's
  // output schema and throw, turning an allowed rehearsal into a protocol error.
  if (response.headers.get(AGENT_PREFLIGHT_VERDICT_HEADER) !== null) {
    return { content: [{ type: 'text', text: JSON.stringify(parsed) }], status, preflightVerdict: true }
  }

  const payload = unwrapInertiaProps(tool, response, parsed)

  if (structured && !isRecord(payload)) {
    return inconsistentOutput(tool, `a ${Array.isArray(payload) ? 'JSON array' : typeof payload} body`, status)
  }

  const outcome: ToolCallOutcome = {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    status,
  }
  if (structured && isRecord(payload)) {
    outcome.structuredContent = payload
  }
  return outcome
}

/**
 * A success response that cannot satisfy the tool's advertised object output
 * schema. An error result is the honest signal that the route and its declared
 * `output` disagree, and it sidesteps the SDK's structuredContent requirement.
 */
function inconsistentOutput(tool: DerivedAgentTool, detail: string, status: number): ToolCallOutcome {
  return {
    content: [
      {
        type: 'text',
        text:
          `The tool "${tool.toolName}" advertises an output schema, but the route returned ${detail} `
          + `(HTTP ${status}) — no structured result could be produced.`,
      },
    ],
    isError: true,
    status,
  }
}

function parseJsonBody(response: Response, raw: string): unknown | undefined {
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!contentType.includes('json') || raw === '') return undefined
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

function unwrapInertiaProps(tool: DerivedAgentTool, response: Response, parsed: unknown): unknown {
  if (tool.outputSchema) return parsed
  if (response.headers.get('X-Inertia') !== 'true') return parsed
  if (!isRecord(parsed) || !('props' in parsed)) return parsed
  return parsed.props
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
