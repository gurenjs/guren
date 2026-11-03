/**
 * The MCP App bridge (RFC 0038 §5): an Inertia `HttpClient` that answers each
 * visit with a tool call through the host, and reads the call's result back as
 * a page. Pure apart from what `BridgeDeps` hands it, so it is tested without
 * a host or a DOM.
 */
import {
  http,
  HttpCancelledError,
  HttpError,
  type HttpClient,
  type HttpRequestConfig,
  type HttpResponse,
  type Page,
} from '@inertiajs/core'
import { TrieRouter } from 'hono/router/trie-router'
import { collectEntries, formDataToObject } from './form-entries'

/**
 * The version of the `dev.guren/*` keys and the catalogue this bridge reads.
 * Kept equal to `MCP_APP_CONTRACT` in `packages/plugin-mcp/src/mcp-apps.ts`;
 * `tests/mcp-app.test.ts` reads that file to check.
 */
export const MCP_APP_CONTRACT = 1
export const RESPONSE_META_KEY = 'dev.guren/response'
export const INERTIA_PAGE_META_KEY = 'dev.guren/inertia-page'
/** The `errors` key a visit the view cannot carry out reports under. */
export const MCP_APP_ERROR_KEY = 'mcp'
/** What the prototype runtime allows too (`MAX_REDIRECT_HOPS` in `prototype.ts`). */
const MAX_REDIRECT_HOPS = 5
const FOLLOWED_AS_GET = new Set([301, 302, 303])
const FOLLOWED_AS_SENT = new Set([307, 308])

export type BridgeInputSource = 'params' | 'path' | 'query' | 'body'

/** One entry of `ui://<server>/bridge`, as `@guren/plugin-mcp` publishes it. */
export interface BridgeTool {
  toolName: string
  method: string
  path: string
  inputSources: Record<string, BridgeInputSource>
  inputBodyNested: boolean
  bridgeable: boolean
  /** The page the tool renders; absent from a server older than this field. */
  page?: string
}

export type GurenToolResponse = { contract: number; bridge?: string } & (
  | { outcome: 'executed'; status: number; url?: string; location?: string; errors?: Record<string, string[]> }
  | { outcome: 'denied'; reason: string; message: string; approval?: { requestId: string; status: string } }
  | { outcome: 'failed'; message: string }
)

/** The parts of an MCP `CallToolResult` the bridge reads. */
export interface ToolResultLike {
  content?: unknown
  structuredContent?: unknown
  isError?: boolean
  _meta?: Record<string, unknown>
}

export function readToolResult(result: ToolResultLike): { response?: GurenToolResponse; page?: Page } {
  const meta = result._meta ?? {}
  const response = meta[RESPONSE_META_KEY]
  const page = meta[INERTIA_PAGE_META_KEY]
  return {
    response: isRecord(response) && typeof response.outcome === 'string' ? (response as GurenToolResponse) : undefined,
    page: isRecord(page) && typeof page.component === 'string' ? (page as unknown as Page) : undefined,
  }
}

/** The tool a visit reaches, matched the way the router picks a route: the first registered. */
export class BridgeCatalogue {
  private readonly router = new TrieRouter<BridgeTool>()

  constructor(tools: readonly BridgeTool[]) {
    for (const tool of tools) this.router.add(tool.method.toUpperCase(), tool.path, tool)
  }

  match(method: string, path: string): { tool: BridgeTool; params: Record<string, string> } | undefined {
    const [handlers, stash] = this.router.match(method, path) as [
      [BridgeTool, Record<string, number> | Record<string, string>][],
      string[] | undefined,
    ]
    const first = handlers[0]
    if (!first) return undefined
    const [tool, paramMap] = first
    const params = new Map<string, string>()
    for (const [key, value] of Object.entries(paramMap)) {
      const raw = typeof value === 'number' ? stash?.[value] : value
      if (raw !== undefined) params.set(key, safeDecode(raw))
    }
    return { tool, params: Object.fromEntries(params) }
  }
}

export interface VisitOrigins {
  /** The sandbox document's origin, which Inertia resolves every visit against. */
  sandbox: string
  /** The application's origin, from the first result's absolute `url`. */
  app?: string
}

export type VisitPlan =
  | {
    kind: 'call'
    tool: BridgeTool
    method: string
    path: string
    /** The path with every query value the visit carried, for a hand-off. */
    requested: string
    arguments: Record<string, unknown>
  }
  | { kind: 'unmatched'; method: string; path: string; reason: string }
  | { kind: 'external'; method: string; url: string }

/**
 * A visit as one tool call, the inverse of `buildToolRequest()`: path
 * parameters, query values and a JSON body flattened into one argument object.
 */
export function planVisit(
  catalogue: BridgeCatalogue | undefined,
  method: string,
  url: string,
  data: unknown,
  origins: VisitOrigins,
  params?: Record<string, unknown>,
): VisitPlan {
  const target = new URL(url, origins.sandbox)
  const sent = method.toUpperCase()
  if (target.origin !== origins.sandbox && target.origin !== origins.app) {
    return { kind: 'external', method: sent, url: target.href }
  }
  const path = target.pathname
  const requested = requestedPath(target, params)
  const body = readBody(data)
  const spoofed = sent === 'POST' && typeof body.value === 'object' && body.value !== null
    && typeof (body.value as Record<string, unknown>)._method === 'string'
    ? String((body.value as Record<string, unknown>)._method).toUpperCase()
    : sent
  if (!catalogue) return { kind: 'unmatched', method: spoofed, path: requested, reason: 'read-only' }
  if (body.file) return { kind: 'unmatched', method: spoofed, path, reason: 'A file upload cannot travel through a tool call.' }

  const match = catalogue.match(spoofed, path)
  if (!match) return { kind: 'unmatched', method: spoofed, path: requested, reason: 'No tool answers this visit.' }
  if (!match.tool.bridgeable) {
    return { kind: 'unmatched', method: spoofed, path, reason: `Tool "${match.tool.toolName}" takes one name from two inputs.` }
  }

  const args = new Map<string, unknown>(Object.entries(match.params))
  const query = collectEntries([...target.searchParams.entries(), ...Object.entries(params ?? {})])
  for (const [key, value] of Object.entries(query)) {
    if (!args.has(key)) args.set(key, value)
  }
  if (match.tool.inputBodyNested) {
    if (body.value !== undefined) args.set('body', body.value)
  } else if (isRecord(body.value)) {
    // The URL names the record: a body carrying a whole record (`useForm(post)`) must not
    // move a path parameter, which `buildToolRequest()` writes back into the path.
    for (const [key, value] of Object.entries(body.value)) {
      if (key !== '_method' && !Object.hasOwn(match.params, key)) args.set(key, value)
    }
  }
  return { kind: 'call', tool: match.tool, method: spoofed, path, requested, arguments: Object.fromEntries(args) }
}

/** `params` is where Inertia puts a GET's data; the browser would have sent them in the query. */
function requestedPath(target: URL, params: Record<string, unknown> | undefined): string {
  const search = new URLSearchParams(target.search)
  for (const [key, value] of Object.entries(params ?? {})) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined && item !== null) search.append(Array.isArray(value) ? `${key}[]` : key, String(item))
    }
  }
  const query = search.toString()
  return query ? `${target.pathname}?${query}` : target.pathname
}

export interface PendingApprovalVisit {
  requestId: string
  toolName: string
  method: string
  url: string
  data: unknown
}

export interface BridgeDeps {
  call(name: string, args: Record<string, unknown>): Promise<ToolResultLike>
  /** Undefined while the view is read-only: no catalogue, no `serverTools`, or another contract. */
  catalogue(): BridgeCatalogue | undefined
  origins(): VisitOrigins
  /** The page Inertia shows now, which a 422 or a refusal is reported on. */
  currentPage(): Page | undefined
  hasComponent(name: string): Promise<boolean>
  /** Open an absolute URL in the browser; the visit settles without changing the page. */
  handOff(url: string): void
  pendingApproval(visit: PendingApprovalVisit): void
  /** A visit the view could not carry out, with the application's URL for the page it stays on. */
  refused?(refusal: { message: string; url?: string }): void
}

type Answer = { kind: 'page'; page: Page } | { kind: 'settled' }

/**
 * Inertia's `HttpClient` over the host. Every visit settles: with a page, with
 * the current page carrying `errors`, or without changing the page, which is an
 * `HttpCancelledError` (Inertia finishes such a visit quietly). It never
 * answers 409, since a location visit assigns `window.location`, which is the
 * sandbox's document (RFC 0038 §5).
 */
export function createMcpAppHttpClient(deps: BridgeDeps): HttpClient {
  return {
    async request(config: HttpRequestConfig): Promise<HttpResponse> {
      const processed = await http.processRequest(config)
      try {
        throwIfAborted(processed.signal, processed.url)
        const bag = headerValue(processed.headers, 'x-inertia-error-bag')
        const answer = await visit(deps, processed.signal, processed.method, processed.url, processed.data, processed.params, bag, 0)
        throwIfAborted(processed.signal, processed.url)
        if (answer.kind === 'settled') throw new HttpCancelledError('Settled by the MCP App bridge', processed.url)
        const response: HttpResponse = {
          status: 200,
          data: JSON.stringify(answer.page),
          headers: { 'x-inertia': 'true', 'content-type': 'application/json; charset=utf-8' },
        }
        return await http.processResponse(response)
      } catch (error) {
        if (error instanceof HttpError) await http.processError(error as HttpCancelledError)
        throw error
      }
    },
  }
}

async function visit(
  deps: BridgeDeps,
  signal: AbortSignal | undefined,
  method: string,
  url: string,
  data: unknown,
  params: Record<string, unknown> | undefined,
  bag: string | undefined,
  hops: number,
): Promise<Answer> {
  const origins = deps.origins()
  const plan = planVisit(deps.catalogue(), method, url, data, origins, params)
  if (plan.kind === 'external') {
    return plan.method === 'GET' ? handOff(deps, plan.url) : refuse(deps, bag, 'This action leaves the application.')
  }
  if (plan.kind === 'unmatched') {
    return plan.method === 'GET'
      ? handOff(deps, appUrl(plan.path, origins))
      : refuse(deps, bag, 'This action is not available here. Open the page in the application to continue.')
  }

  // A page this document does not bundle opens in the browser whatever the call
  // returns, so the call is not made (RFC 0038 §7 builds one document per page).
  if (plan.method === 'GET' && plan.tool.page !== undefined && !(await deps.hasComponent(plan.tool.page))) {
    return handOff(deps, appUrl(plan.requested, origins))
  }

  // Checked before every call, a redirect's included: a cancelled visit must not send another write.
  throwIfAborted(signal, url)
  let result: ToolResultLike
  try {
    result = await deps.call(plan.tool.toolName, plan.arguments)
  } catch (error) {
    // The host refused the call, the user declined it, or the connection dropped.
    return refuse(deps, bag, error instanceof Error && error.message ? error.message : 'The host could not run this action.')
  }
  const { response, page } = readToolResult(result)
  if (!response || response.contract !== MCP_APP_CONTRACT) {
    return plan.method === 'GET'
      ? handOff(deps, appUrl(plan.requested, origins))
      : refuse(deps, bag, 'The application was updated. Open it to continue.')
  }

  if (response.outcome === 'failed') return refuse(deps, bag, response.message)
  if (response.outcome === 'denied') {
    if (response.approval?.status === 'pending') {
      deps.pendingApproval({ requestId: response.approval.requestId, toolName: plan.tool.toolName, method, url, data })
      return { kind: 'settled' }
    }
    return refuse(deps, bag, response.message)
  }

  if (page) {
    if (!(await deps.hasComponent(page.component))) return handOff(deps, response.url ?? appUrl(plan.requested, origins))
    const current = deps.currentPage()
    return { kind: 'page', page: { ...page, version: current?.version ?? page.version } }
  }
  if (response.location && (FOLLOWED_AS_GET.has(response.status) || FOLLOWED_AS_SENT.has(response.status))) {
    if (hops >= MAX_REDIRECT_HOPS) return refuse(deps, bag, `Redirect loop: ${MAX_REDIRECT_HOPS} hops ending at ${response.location}`)
    const location = new URL(response.location)
    if (location.origin !== origins.app) return handOff(deps, location.href)
    const keep = FOLLOWED_AS_SENT.has(response.status)
    const next = `${location.pathname}${location.search}`
    return visit(deps, signal, keep ? plan.method : 'GET', next, keep ? data : undefined, undefined, bag, hops + 1)
  }
  if (response.status === 422 && response.errors) return errorsPage(deps, bag, firstMessages(response.errors))
  return plan.method === 'GET'
    ? handOff(deps, response.url ?? appUrl(plan.requested, origins))
    : refuse(deps, bag, `The application answered ${response.status}, which this view cannot show.`)
}

function handOff(deps: BridgeDeps, url: string): Answer {
  deps.handOff(url)
  return { kind: 'settled' }
}

function refuse(deps: BridgeDeps, bag: string | undefined, message: string): Answer {
  const current = deps.currentPage()
  deps.refused?.({ message, url: current ? appUrl(current.url, deps.origins()) : undefined })
  return errorsPage(deps, bag, { [MCP_APP_ERROR_KEY]: message })
}

/** The current page with `errors` set, as the server's redirect back after a failed validation would render it. */
function errorsPage(deps: BridgeDeps, bag: string | undefined, errors: Record<string, string>): Answer {
  const current = deps.currentPage()
  if (!current) return { kind: 'settled' }
  const props = { ...current.props, errors: bag ? { [bag]: errors } : errors } as Page['props']
  return { kind: 'page', page: { ...current, props } }
}

/** Inertia expects one message per field; the server's JSON 422 carries arrays. */
function firstMessages(errors: Record<string, string[]>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(errors).map(([field, messages]) => [field, Array.isArray(messages) ? String(messages[0] ?? '') : String(messages)]),
  )
}

function appUrl(path: string, origins: VisitOrigins): string {
  return origins.app ? new URL(path, origins.app).href : path
}

function readBody(data: unknown): { value?: unknown; file: boolean } {
  if (data === undefined || data === null || data === '') return { file: false }
  if (typeof FormData !== 'undefined' && data instanceof FormData) {
    const value = formDataToObject(data)
    return { value, file: containsBlob(value) }
  }
  if (typeof data === 'string') {
    try {
      return { value: JSON.parse(data), file: false }
    } catch {
      return { value: data, file: false }
    }
  }
  return { value: data, file: containsBlob(data) }
}

function containsBlob(value: unknown): boolean {
  if (typeof Blob !== 'undefined' && value instanceof Blob) return true
  if (Array.isArray(value)) return value.some(containsBlob)
  if (isRecord(value)) return Object.values(value).some(containsBlob)
  return false
}

function headerValue(headers: HttpRequestConfig['headers'], name: string): string | undefined {
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === name && value !== undefined && value !== null && value !== '') return String(value)
  }
  return undefined
}

function throwIfAborted(signal: AbortSignal | undefined, url: string): void {
  if (signal?.aborted) throw new HttpCancelledError('Request was cancelled', url)
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
