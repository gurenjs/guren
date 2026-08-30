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
import type { DerivedAgentTool } from '@guren/core'
import { PATH_PARAM_PATTERN } from '@guren/core/internal/route-path'

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
}

export type BuiltToolRequest =
  | { request: Request }
  /** Path parameters the call did not supply — the URL cannot be built. */
  | { missing: string[] }

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
  const consumed = new Set<string>()

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
      consumed.add(name)
      return `${lead}${encodeURIComponent(String(value))}`
    },
  )
  if (missing.length > 0) {
    return { missing }
  }

  const method = tool.method
  const bodyless = method === 'GET' || method === 'HEAD'

  const query = new URLSearchParams()
  const bodyEntries: Array<[string, unknown]> = []
  for (const [key, value] of Object.entries(args)) {
    if (consumed.has(key) || value === undefined) continue
    const source = Object.hasOwn(tool.inputSources, key) ? tool.inputSources[key] : undefined
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
 * Map the application's response onto an MCP tool result (RFC 0016 §3.4).
 *
 * - 2xx JSON → serialized text, plus `structuredContent` when the tool
 *   advertises an `outputSchema` (the one shape the route validated).
 * - 2xx Inertia page JSON → unwrapped to `page.props`, only for a tool with
 *   no `outputSchema` — unwrap and schema are mutually exclusive by
 *   derivation, so the advertised shape can never disagree with the result.
 * - 204 / 3xx → a status line naming the Location; not an error.
 * - 4xx / 5xx → `isError: true` carrying the exception handler's JSON body:
 *   a 422's `{ message, errors }` is an application-level failure the agent
 *   should read, not a protocol error.
 * - non-JSON → capped text.
 */
export async function mapToolResponse(
  tool: DerivedAgentTool,
  response: Response,
): Promise<ToolCallOutcome> {
  const status = response.status

  if (status === 204 || (status >= 300 && status < 400)) {
    const location = response.headers.get('Location')
    const text = location ? `HTTP ${status} (Location: ${location})` : `HTTP ${status}`
    return { content: [{ type: 'text', text }], status }
  }

  const raw = await response.text()
  const parsed = parseJsonBody(response, raw)

  if (status >= 400) {
    return {
      content: [{ type: 'text', text: raw || `HTTP ${status}` }],
      isError: true,
      status,
    }
  }

  if (parsed === undefined) {
    const text = raw.length > TEXT_RESPONSE_CAP
      ? `${raw.slice(0, TEXT_RESPONSE_CAP)}… [truncated ${raw.length - TEXT_RESPONSE_CAP} characters]`
      : raw
    return { content: [{ type: 'text', text }], status }
  }

  const payload = unwrapInertiaProps(tool, response, parsed)
  const outcome: ToolCallOutcome = {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    status,
  }
  if (tool.outputSchema && isRecord(payload)) {
    outcome.structuredContent = payload
  }
  return outcome
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
