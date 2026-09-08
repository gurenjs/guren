/**
 * Prototype mode (RFC 0021 Part 1): a fixture module answers Inertia visits by
 * route name, run in the browser as Inertia 3's public `HttpClient`, so a
 * statically hosted build of the real page components works with no server.
 * Browser-safe: no `@guren/server` import; the server consumes
 * `PrototypeResult` structurally (Part 2).
 */
import {
  http,
  HttpCancelledError,
  HttpError,
  HttpResponseError,
  type HttpClient,
  type HttpRequestConfig,
  type HttpResponse,
  type Page,
} from '@inertiajs/core'
import { TrieRouter } from 'hono/router/trie-router'
import type { AnyPageContract, PageProps } from './contracts'
import { substituteRouteParams, type RouteManifestLike, type RoutePathParams } from './components'
import type { RouteBody } from './typed-forms'

export type PrototypeResult =
  | { kind: 'page'; component: string; props: Record<string, unknown> }
  | { kind: 'redirect'; to: string; params?: Record<string, string | number> }
  | { kind: 'location'; url: string }
  | { kind: 'errors'; errors: Record<string, string>; bag?: string }
  | { kind: 'not-found' }

export type PrototypeQuery = Record<string, string | string[]>

/** Incoming path parameters: what the URL carried, so always strings. */
export type PrototypeParams<TPath extends string> = {
  [TKey in keyof RoutePathParams<TPath>]: string
}

export type PrototypeBody<TApi, TName> = TName extends keyof TApi ? RouteBody<TApi, TName> : unknown

export interface PrototypeContext<
  TManifest extends RouteManifestLike,
  TName extends keyof TManifest & string,
  TApi,
  TShared extends Record<string, unknown>,
  TState,
> {
  method: string
  /** Path plus query string, as the browser saw it (base stripped). */
  url: string
  params: PrototypeParams<TManifest[TName]['path']>
  query: PrototypeQuery
  body: PrototypeBody<TApi, TName>
  state: TState
  shared: TShared
  page<P extends AnyPageContract>(contract: P, props: PageProps<P>): PrototypeResult
  redirect<TTarget extends keyof TManifest & string>(
    to: TTarget,
    ...params: RoutePathParams<TManifest[TTarget]['path']> extends Record<string, never>
      ? [params?: Record<string, never>]
      : [params: RoutePathParams<TManifest[TTarget]['path']>]
  ): PrototypeResult
  location(url: string): PrototypeResult
  errors(errors: Record<string, string>, bag?: string): PrototypeResult
  notFound(): PrototypeResult
  /** Top-level Inertia `flash` on the answering page, what `flash()` in a controller becomes on the wire. */
  flash(key: string, value: unknown): void
}

export type PrototypeHandler<
  TManifest extends RouteManifestLike,
  TName extends keyof TManifest & string,
  TApi,
  TShared extends Record<string, unknown>,
  TState,
> = (ctx: PrototypeContext<TManifest, TName, TApi, TShared, TState>) => PrototypeResult | Promise<PrototypeResult>

export type PrototypePersistence = 'session' | 'local' | false

export interface PrototypeInput<
  TManifest extends RouteManifestLike,
  TApi,
  TShared extends Record<string, unknown>,
  TState,
> {
  /** `routeManifest` from `.guren/routes.gen.ts`: the value types the keys and paths, the runtime matches with it. */
  manifest: TManifest
  /** Phantom: `apiRoutes<ApiRoutes>()` types each handler's `body` from the route's `body` schema. */
  api?: TApi
  /** Props every page carries under its own, like `shareInertiaProps()`. `satisfies InertiaSharedProps` pins it to the app's contract. */
  shared?: TShared
  state?: () => TState
  /** Where the browser keeps `state` between reloads. Default `'session'`. */
  persist?: PrototypePersistence
  /** Rendered as a 200 for `notFound()` and unmatched URLs; without it the client answers the 404 JSON the server does. */
  notFoundPage?: AnyPageContract
  routes: {
    [TName in keyof TManifest & string]?: PrototypeHandler<TManifest, TName, TApi, TShared, TState>
  }
}

export interface PrototypeDefinition<
  TManifest extends RouteManifestLike = RouteManifestLike,
  TApi = unknown,
  TShared extends Record<string, unknown> = Record<string, unknown>,
  TState = unknown,
> extends PrototypeInput<TManifest, TApi, TShared, TState> {
  readonly [PROTOTYPE_BRAND]: true
}

const PROTOTYPE_BRAND: unique symbol = Symbol.for('guren.prototype')

export function definePrototype<
  TManifest extends RouteManifestLike,
  TApi = unknown,
  TShared extends Record<string, unknown> = Record<string, never>,
  TState = Record<string, never>,
>(input: PrototypeInput<TManifest, TApi, TShared, TState>): PrototypeDefinition<TManifest, TApi, TShared, TState> {
  return { ...input, [PROTOTYPE_BRAND]: true }
}

/**
 * A definition with its generics erased: what a loader hands over and the
 * runtime consumes. Handler contexts are contravariant in the manifest, so a
 * typed definition is not assignable to the default-generic one.
 */
export type AnyPrototypeDefinition = PrototypeDefinition<any, any, any, any>

export function isPrototypeDefinition(value: unknown): value is AnyPrototypeDefinition {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[PROTOTYPE_BRAND] === true
}

/** Carries `ApiRoutes` from `.guren/api-client.gen.ts` into `definePrototype({ api })` without a runtime value. */
export function apiRoutes<TApi>(): TApi {
  return undefined as TApi
}

export function page<P extends AnyPageContract>(contract: P, props: PageProps<P>): PrototypeResult {
  return { kind: 'page', component: contract.component ?? contract.id, props: props as Record<string, unknown> }
}

export function redirect(to: string, params?: Record<string, string | number>): PrototypeResult {
  return { kind: 'redirect', to, params }
}

export function location(url: string): PrototypeResult {
  return { kind: 'location', url }
}

export function errors(errors: Record<string, string>, bag?: string): PrototypeResult {
  return { kind: 'errors', errors, bag }
}

export function notFound(): PrototypeResult {
  return { kind: 'not-found' }
}

export interface PrototypeStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface PrototypeRuntimeOptions {
  /** Vite's `base` for a build hosted under a subpath: stripped before matching, prefixed on every URL the client emits. */
  base?: string
  /** Overrides the storage `persist` selects; tests pass a map. */
  storage?: PrototypeStorage
  /** The page a validation failure "redirects back" to; defaults to `window.location`. */
  currentUrl?: () => string | undefined
}

export const PROTOTYPE_STATE_KEY = 'guren.prototype.state'
const STATE_VERSION = 1
/** Redirect hops one visit may chain before the client gives up, as a browser would on a loop. */
const MAX_REDIRECT_HOPS = 5

/** Drops persisted state from both storages; the next load starts from `state()` again. */
export function resetPrototypeState(): void {
  for (const name of ['sessionStorage', 'localStorage'] as const) {
    try {
      const storage = (globalThis as Record<string, unknown>)[name] as PrototypeStorage | undefined
      storage?.removeItem(PROTOTYPE_STATE_KEY)
    } catch {
      // Storage access itself throws in some browsers' private modes.
    }
  }
}

interface Dispatched {
  status: number
  headers: Record<string, string>
  body: string
}

interface DispatchOptions {
  hops?: number
  /** Flash carried from the hop that redirected here. */
  flash?: Record<string, unknown>
  /** `X-Inertia-Error-Bag` of the visit, applied when the handler names none. */
  errorBag?: string
}

interface AnswerPage extends Page {
  version: null
}

type AnyHandler = PrototypeHandler<RouteManifestLike, string, unknown, Record<string, unknown>, unknown>

/**
 * The matching, state and result mapping both entry points share, so the
 * initial page and every later visit go through one code path.
 */
class PrototypeRuntime {
  private readonly router = new TrieRouter<string>()
  private readonly base: string
  private readonly storage: PrototypeStorage | undefined
  private state: unknown
  private stateLoaded = false

  constructor(
    private readonly definition: AnyPrototypeDefinition,
    private readonly options: PrototypeRuntimeOptions = {},
  ) {
    this.base = normalizeBase(options.base)
    this.storage = options.storage ?? selectStorage(definition.persist ?? 'session')
    for (const [name, route] of Object.entries(definition.manifest as RouteManifestLike)) {
      this.router.add(route.method.toUpperCase(), route.path, name)
    }
  }

  stripBase(pathname: string): string {
    if (this.base === '/') return pathname
    const prefix = this.base.slice(0, -1)
    if (pathname === prefix) return '/'
    return pathname.startsWith(this.base) ? pathname.slice(prefix.length) : pathname
  }

  withBase(path: string): string {
    if (this.base === '/') return path
    return `${this.base.slice(0, -1)}${path.startsWith('/') ? path : `/${path}`}`
  }

  async dispatch(method: string, target: string, body: unknown, options: DispatchOptions = {}): Promise<Dispatched> {
    const hops = options.hops ?? 0
    const url = new URL(target, 'http://prototype.invalid')
    const path = this.stripBase(url.pathname)
    const bodyObject = toBodyObject(body)
    const spoofed = method.toUpperCase() === 'POST' && typeof bodyObject?._method === 'string'
      ? String(bodyObject._method).toUpperCase()
      : method.toUpperCase()

    const match = this.match(spoofed, path)
    if (!match) return this.notFoundAnswer(path + url.search, `No named route matches ${spoofed} ${path}`)

    const handler = this.definition.routes[match.name] as AnyHandler | undefined
    if (!handler) {
      return this.notFoundAnswer(
        path + url.search,
        `Route "${match.name}" has no fixture entry in resources/js/prototype/index.ts`,
      )
    }

    // Flash set by an earlier hop rides along, as a session flash survives the
    // redirect a mutating action answers with.
    const flash: Record<string, unknown> = { ...options.flash }
    const ctx = this.context(spoofed, path + url.search, match.params, parseQuery(url.searchParams), bodyObject ?? body, flash)
    const result = await handler(ctx)
    this.persistState()

    return this.answer(result, path + url.search, flash, { ...options, hops })
  }

  private async answer(
    result: PrototypeResult,
    requestUrl: string,
    flash: Record<string, unknown>,
    options: DispatchOptions & { hops: number },
  ): Promise<Dispatched> {
    const next = { ...options, hops: options.hops + 1, flash }
    switch (result.kind) {
      case 'page':
        return this.pageAnswer(result.component, result.props, requestUrl, flash)
      case 'redirect': {
        if (options.hops >= MAX_REDIRECT_HOPS) {
          return this.notFoundAnswer(requestUrl, `Redirect loop: ${MAX_REDIRECT_HOPS} hops ending at ${result.to}`)
        }
        return this.dispatch('GET', this.withBase(this.routePath(result.to, result.params)), undefined, next)
      }
      case 'location':
        return { status: 409, headers: { 'x-inertia-location': result.url }, body: '' }
      case 'errors': {
        const back = this.currentPath() ?? requestUrl
        const answer = await this.dispatch('GET', this.withBase(back), undefined, next)
        if (answer.headers['x-inertia'] !== 'true') return answer
        const page = JSON.parse(answer.body) as AnswerPage
        const bag = result.bag ?? options.errorBag
        page.props.errors = (bag ? { [bag]: result.errors } : result.errors) as AnswerPage['props']['errors']
        return { ...answer, body: JSON.stringify(page) }
      }
      case 'not-found':
        return this.notFoundAnswer(requestUrl, `Fixture returned notFound() for ${requestUrl}`)
    }
  }

  private pageAnswer(component: string, props: Record<string, unknown>, requestUrl: string, flash: Record<string, unknown>): Dispatched {
    const page: AnswerPage = {
      component,
      props: { ...this.definition.shared, ...props, errors: {} } as AnswerPage['props'],
      url: this.withBase(requestUrl),
      version: null,
      flash,
      rescuedProps: [],
      clearHistory: false,
      encryptHistory: false,
      rememberedState: {},
    }
    return {
      status: 200,
      headers: { 'x-inertia': 'true', 'content-type': 'application/json; charset=utf-8', vary: 'Accept' },
      body: JSON.stringify(page),
    }
  }

  private notFoundAnswer(requestUrl: string, message: string): Dispatched {
    if (this.definition.notFoundPage) {
      return this.pageAnswer(
        this.definition.notFoundPage.component ?? this.definition.notFoundPage.id,
        { status: 404, message },
        requestUrl,
        {},
      )
    }
    // What ExceptionHandler answers an Inertia request with: JSON, no x-inertia
    // header, which the client shows in its error dialog.
    return {
      status: 404,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ message, statusCode: 404 }),
    }
  }

  routePath(name: string, params?: Record<string, string | number>): string {
    const route = (this.definition.manifest as RouteManifestLike)[name]
    if (!route) throw new Error(`Prototype redirect names an unknown route "${name}".`)
    return substituteRouteParams(route.path, params)
  }

  private match(method: string, path: string): { name: string; params: Record<string, string> } | undefined {
    const result = this.router.match(method, path)
    const [handlers, stash] = result as [[string, Record<string, number> | Record<string, string>][], string[] | undefined]
    const first = handlers[0]
    if (!first) return undefined
    const [name, paramMap] = first
    const params: Record<string, string> = {}
    for (const [key, value] of Object.entries(paramMap)) {
      const raw = typeof value === 'number' ? stash?.[value] : value
      if (raw !== undefined) params[key] = safeDecode(raw)
    }
    return { name, params }
  }

  private context(
    method: string,
    url: string,
    params: Record<string, string>,
    query: PrototypeQuery,
    body: unknown,
    flash: Record<string, unknown>,
  ): PrototypeContext<RouteManifestLike, string, unknown, Record<string, unknown>, unknown> {
    return {
      method,
      url,
      params,
      query,
      body,
      state: this.loadState(),
      shared: this.definition.shared ?? {},
      page,
      redirect: (to, params?: Record<string, string | number>) => redirect(to, params),
      location,
      errors,
      notFound,
      flash: (key, value) => {
        flash[key] = value
      },
    }
  }

  loadState(): unknown {
    if (this.stateLoaded) return this.state
    this.stateLoaded = true
    const stored = this.readStoredState()
    this.state = stored !== undefined ? stored : (this.definition.state?.() ?? {})
    return this.state
  }

  private readStoredState(): unknown {
    if (!this.storage) return undefined
    try {
      const raw = this.storage.getItem(PROTOTYPE_STATE_KEY)
      if (!raw) return undefined
      const envelope = JSON.parse(raw) as { v?: number; state?: unknown }
      return envelope.v === STATE_VERSION ? envelope.state : undefined
    } catch {
      return undefined
    }
  }

  private persistState(): void {
    if (!this.storage || !this.stateLoaded) return
    try {
      this.storage.setItem(PROTOTYPE_STATE_KEY, JSON.stringify({ v: STATE_VERSION, state: this.state }, dropBlobs))
    } catch {
      // Quota or a private-mode refusal: the in-memory state stays authoritative for this tab.
    }
  }

  private currentPath(): string | undefined {
    const current = this.options.currentUrl
      ? this.options.currentUrl()
      : typeof window !== 'undefined' && window.location
        ? `${window.location.pathname}${window.location.search}`
        : undefined
    if (!current) return undefined
    const url = new URL(current, 'http://prototype.invalid')
    return this.stripBase(url.pathname) + url.search
  }
}

function dropBlobs(_key: string, value: unknown): unknown {
  return typeof Blob !== 'undefined' && value instanceof Blob ? undefined : value
}

function normalizeBase(base: string | undefined): string {
  if (!base || base === '/' || base === './' || base === '') return '/'
  const trimmed = base.replace(/^\.?\/*/u, '/').replace(/\/*$/u, '/')
  return trimmed === '//' ? '/' : trimmed
}

function selectStorage(persist: PrototypePersistence): PrototypeStorage | undefined {
  if (persist === false) return undefined
  try {
    const name = persist === 'local' ? 'localStorage' : 'sessionStorage'
    return (globalThis as Record<string, unknown>)[name] as PrototypeStorage | undefined
  } catch {
    return undefined
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function parseQuery(params: URLSearchParams): PrototypeQuery {
  const query: PrototypeQuery = {}
  for (const [rawKey, value] of params) {
    const key = rawKey.endsWith('[]') ? rawKey.slice(0, -2) : rawKey
    appendValue(query, key, value, rawKey.endsWith('[]'))
  }
  return query
}

function appendValue(target: Record<string, unknown>, key: string, value: unknown, forceArray: boolean): void {
  const existing = target[key]
  if (existing === undefined) {
    target[key] = forceArray ? [value] : value
  } else if (Array.isArray(existing)) {
    existing.push(value)
  } else {
    target[key] = [existing, value]
  }
}

/** A `FormData` body as a plain object; a repeated key or a `name[]` key becomes an array. */
export function formDataToObject(data: FormData): Record<string, unknown> {
  const object: Record<string, unknown> = {}
  for (const [rawKey, value] of data.entries()) {
    const key = rawKey.endsWith('[]') ? rawKey.slice(0, -2) : rawKey
    appendValue(object, key, value, rawKey.endsWith('[]'))
  }
  return object
}

function toBodyObject(body: unknown): Record<string, unknown> | undefined {
  if (typeof FormData !== 'undefined' && body instanceof FormData) return formDataToObject(body)
  if (typeof body === 'string') {
    try {
      const parsed: unknown = JSON.parse(body)
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined
    } catch {
      return undefined
    }
  }
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) return body as Record<string, unknown>
  return undefined
}

function headerValue(headers: HttpRequestConfig['headers'], name: string): string | undefined {
  if (!headers) return undefined
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted && value !== undefined && value !== null) return String(value)
  }
  return undefined
}

function splitList(value: string | undefined): string[] {
  return value ? value.split(',').map((item) => item.trim()).filter(Boolean) : []
}

/**
 * Only the requested props, as a server answers a partial reload:
 * `Response.mergeProps()` overlays every returned prop on the current page.
 * `errors` stays, since Inertia decides itself whether to preserve it.
 */
function applyPartial(page: AnswerPage, headers: HttpRequestConfig['headers']): AnswerPage {
  const component = headerValue(headers, 'X-Inertia-Partial-Component')
  if (!component || component !== page.component) return page
  const only = new Set(splitList(headerValue(headers, 'X-Inertia-Partial-Data')).map((key) => key.split('.')[0]!))
  const except = new Set(splitList(headerValue(headers, 'X-Inertia-Partial-Except')).map((key) => key.split('.')[0]!))
  if (only.size === 0 && except.size === 0) return page
  const props: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(page.props)) {
    const keep = only.size > 0 ? only.has(key) : !except.has(key)
    if (keep || key === 'errors') props[key] = value
  }
  return { ...page, props: props as AnswerPage['props'] }
}

function throwIfAborted(signal: AbortSignal | undefined, url: string): void {
  if (signal?.aborted) throw new HttpCancelledError('Request was cancelled', url)
}

export interface PrototypeHttpClient extends HttpClient {
  readonly runtime: PrototypeRuntime
}

/**
 * Inertia's `HttpClient` answered from the fixture. Mirrors `XhrHttpClient`
 * around the answer: the public request/response/error handlers run, an
 * aborted `signal` rejects with `HttpCancelledError`, a 4xx/5xx rejects with
 * `HttpResponseError` so `Request` routes it into `Response` as it would a
 * network 404.
 */
export function createPrototypeHttpClient(
  definition: AnyPrototypeDefinition,
  options: PrototypeRuntimeOptions = {},
): PrototypeHttpClient {
  const runtime = new PrototypeRuntime(definition, options)

  return {
    runtime,
    async request(config: HttpRequestConfig): Promise<HttpResponse> {
      const processed = await http.processRequest(config)
      try {
        throwIfAborted(processed.signal, processed.url)
        const target = withParams(processed.url, processed.params)
        const answered = await runtime.dispatch(processed.method, target, processed.data, {
          errorBag: headerValue(processed.headers, 'X-Inertia-Error-Bag'),
        })
        throwIfAborted(processed.signal, processed.url)

        let body = answered.body
        if (answered.headers['x-inertia'] === 'true' && processed.method.toUpperCase() === 'GET') {
          body = JSON.stringify(applyPartial(JSON.parse(body) as AnswerPage, processed.headers))
        }
        const response: HttpResponse = { status: answered.status, data: body, headers: answered.headers }
        if (response.status >= 400) {
          throw new HttpResponseError(`Request failed with status ${response.status}`, response, processed.url)
        }
        return await http.processResponse(response)
      } catch (error) {
        if (error instanceof HttpError) {
          await http.processError(error as HttpResponseError | HttpCancelledError)
        }
        throw error
      }
    },
  }
}

function withParams(url: string, params: Record<string, unknown> | undefined): string {
  if (!params || Object.keys(params).length === 0) return url
  const target = new URL(url, 'http://prototype.invalid')
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const item of value) target.searchParams.append(`${key}[]`, String(item))
    } else if (value !== undefined && value !== null) {
      target.searchParams.append(key, String(value))
    }
  }
  return target.href
}

/**
 * The page for the URL the static shell was opened at, for
 * `createInertiaApp({ page })`. A URL no fixture answers renders the
 * `notFoundPage` when there is one; otherwise this throws, since there is no
 * page to hand Inertia and the dialog it would show needs a running app.
 */
export async function resolveInitialPage(
  client: PrototypeHttpClient,
  location: { pathname: string; search: string },
): Promise<Page> {
  const answered = await client.runtime.dispatch('GET', `${location.pathname}${location.search}`, undefined)
  if (answered.headers['x-inertia'] !== 'true') {
    const detail = (JSON.parse(answered.body || '{}') as { message?: string }).message ?? `${answered.status}`
    throw new Error(`Prototype mode cannot render ${location.pathname}: ${detail}`)
  }
  return JSON.parse(answered.body) as Page
}
