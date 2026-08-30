/**
 * The dispatch contract (RFC 0016 §3): a tool call re-enters the application
 * as a real HTTP request, so validation, policies, and middleware run exactly
 * once, in the app — never re-implemented here.
 *
 * This module is pure request/response plumbing: it rebuilds an HTTP request
 * from a flat tool call and maps the app's response onto an MCP tool result.
 * It never validates arguments (the route does, and the MCP client already
 * saw the JSON Schema) and never decides authorization (the gate and the
 * app's policies do).
 */
import type { AgentToolInputSource, DerivedAgentTool } from './derive'
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
}

/**
 * The argument-level spelling of a preflight request (RFC 0016 §5.4), for a
 * surface whose callers pass flat arguments rather than dispatch options.
 *
 * No adapter strips it today: MCP does not offer preflight at all (see
 * `mapToolResponse` and the plugin), and the surfaces that do reach the seam
 * ask through `BuildToolRequestOptions.preflight`. A surface that adopts this
 * key owns the stripping — it is an instruction to the adapter, not a field of
 * any route's contract, and forwarding it would fail the very validation the
 * caller asked to rehearse.
 */
export const PREFLIGHT_ARGUMENT = '_preflight'

export type BuiltToolRequest =
  | { request: Request }
  /** Path parameters the call did not supply — the URL cannot be built. */
  | { missing: string[] }
  /**
   * Path parameter values that are URL dot-segments (`.` / `..`). Rejected,
   * never substituted: `encodeURIComponent` leaves a dot untouched, and the
   * `Request` URL parser then collapses the segment — so `{ name: '..' }` on
   * `/files/:name/meta` would reach `/meta`, a route the scope check never
   * saw. The only ASCII segments the WHATWG parser normalizes are `.` and
   * `..`; every other separator (`/`, `\`) survives `encodeURIComponent`
   * percent-encoded, so this is the complete set.
   */
  | { invalidPath: string[] }

/**
 * Rebuild the HTTP request a tool call describes.
 *
 * The flat argument object is taken apart along `tool.inputSources` — the
 * derivation's own record of which contract each property came from — so a
 * POST route's `query` keys land in the query string where `validateQuery`
 * reads them, not in the body. Keys the derivation never advertised are
 * forwarded anyway (body for body-carrying methods, query otherwise): the
 * route's validator is the one place that rejects them, and dropping them
 * here would make this a second, quieter validator.
 *
 * GET and HEAD force everything into the query string whatever its source —
 * `Request` refuses a body on those methods, and a `body` schema on a GET
 * route is a contract defect this adapter cannot repair.
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
  // resolved to `query`/`body` (a collision the derivation warns about) fills
  // the path — the URL needs it — and still flows to its declared sink below,
  // so it is not added here.
  const pathOnly = new Set<string>()

  // The one path lexer (PATH_PARAM_PATTERN) does the substitution, so the
  // names replaced here are exactly the names the derivation advertised —
  // `:name*` is a parameter literally named `name*` on both sides.
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
      // A name the merge assigned to query/body still substitutes into the
      // URL, but keeps flowing to that sink — so a collision does not drop
      // the argument from the body the route validates.
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
    // `params`/`path` key the path never declared (a contract defect
    // `guren check` fails — forwarded so the route's validation reports it
    // rather than it vanishing here); and, on a nested-body route, any key
    // that is not the body itself, since that body is `args.body` verbatim
    // and has no object to absorb strays.
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
    // What turns an Inertia route into page JSON instead of an HTML document
    // — without engaging the `X-Inertia` visit protocol and its 409 version
    // negotiation, which a stateless tool call has no version to answer.
    Accept: 'application/json',
    'X-Guren-Agent-Surface': 'mcp',
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
      // The route validates a non-object body (an array, a primitive), which
      // the derivation nested under `body` to give the tool an object root.
      // Unwrapped here: posting `{ body: [...] }` would hand the validator an
      // object where it expects the array.
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
}

/**
 * Whether the tool advertises an object output schema — the only kind MCP
 * lists, and therefore the only kind that obliges a success result to carry
 * `structuredContent`. A route whose `output` is an array or primitive is not
 * advertised as structured (MCP `outputSchema` must be an object), so its
 * results ride as text. `describeTool` and `mapToolResponse` must agree on
 * this exact predicate, or one advertises a schema the other cannot satisfy.
 */
export function advertisesStructuredOutput(tool: DerivedAgentTool): boolean {
  return tool.outputSchema?.type === 'object'
}

/**
 * Map the application's response onto an MCP tool result (RFC 0016 §3.4).
 *
 * - 2xx JSON object → serialized text, plus `structuredContent` when the tool
 *   advertises an object `outputSchema` (the one shape the route validated).
 * - 2xx Inertia page JSON → unwrapped to `page.props`, only for a tool with
 *   no `outputSchema` — unwrap and schema are mutually exclusive by
 *   derivation, so the advertised shape can never disagree with the result.
 * - 204 / 3xx → a status line naming the Location; not an error.
 * - 4xx / 5xx → `isError: true` carrying the exception handler's JSON body:
 *   a 422's `{ message, errors }` is an application-level failure the agent
 *   should read, not a protocol error.
 * - non-JSON → capped text.
 *
 * One MCP invariant overrides the table: a *non-error* result for a tool that
 * advertises an object `outputSchema` must carry `structuredContent`, or the
 * SDK client rejects it after the route has already run. A success response
 * that yields no object to put there (204, 3xx, non-JSON, a non-object body)
 * contradicts the route's own declared output, so it becomes an `isError`
 * result naming the mismatch — which the SDK exempts from the rule — rather
 * than a protocol fault the agent cannot interpret.
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

  // A preflight verdict is not the route's output: the handler never ran.
  // Returned as plain content whatever the tool advertises — put in
  // `structuredContent`, an SDK client would validate it against the tool's
  // output schema and throw, turning an allowed rehearsal into a protocol
  // error.
  if (response.headers.get(AGENT_PREFLIGHT_VERDICT_HEADER) !== null) {
    return { content: [{ type: 'text', text: JSON.stringify(parsed) }], status }
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
 * schema. Returned as an error result — the honest signal that the route and
 * its declared `output` disagree — which also sidesteps the SDK's
 * structuredContent requirement (errors are exempt).
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
