// Generated — DO NOT EDIT
// Run `guren codegen` to regenerate.

/**
 * Typed API route registry.
 * Use with `createApiClient<ApiRoutes>()` for end-to-end type safety.
 *
 * `body` is the *request* shape — what you send. Coercing schemas are rendered
 * as they travel: `z.coerce.date()` is a `string` here, not the `Date` the
 * controller ends up with. `response` is the parsed shape you get back.
 * Params are not stored on the entries: they are derived from each entry's
 * `path` literal, the same string the server routes on.
 */
export interface ApiRoutes {
  'dashboard': {
    method: 'GET'
    path: '/dashboard'
  }
  'home': {
    method: 'GET'
    path: '/'
  }
  'login': {
    method: 'GET'
    path: '/login'
  }
  'login.store': {
    method: 'POST'
    path: '/login'
  }
  'logout': {
    method: 'POST'
    path: '/logout'
  }
  'posts.create': {
    method: 'GET'
    path: '/posts/create'
  }
  'posts.destroy': {
    method: 'DELETE'
    path: '/posts/:id'
  }
  'posts.edit': {
    method: 'GET'
    path: '/posts/:id/edit'
  }
  'posts.index': {
    method: 'GET'
    path: '/posts'
  }
  'posts.search': {
    method: 'QUERY'
    path: '/posts/search'
    body: { keywords: string[]; limit?: number }
  }
  'posts.show': {
    method: 'GET'
    path: '/posts/:id'
  }
  'posts.store': {
    method: 'POST'
    path: '/posts'
    body: { title: string; excerpt: string; body: string }
  }
  'posts.update': {
    method: 'PUT'
    path: '/posts/:id'
    body: { title: string; excerpt: string; body: string }
  }
  'profile.edit': {
    method: 'GET'
    path: '/profile'
  }
  'profile.update': {
    method: 'PUT'
    path: '/profile'
  }
  'register': {
    method: 'GET'
    path: '/register'
  }
  'register.store': {
    method: 'POST'
    path: '/register'
  }
}

export type ApiRouteName = keyof ApiRoutes

export type ApiRouteMethod<T extends ApiRouteName> = ApiRoutes[T]['method']
export type ApiRoutePath<T extends ApiRouteName> = ApiRoutes[T]['path']

type NormalizeParamKey<TValue extends string> = TValue extends `${infer Key}?` ? Key : TValue
type PathParamKeys<TPath extends string> =
  TPath extends `${string}:${infer Param}/${infer Rest}`
    ? NormalizeParamKey<Param> | PathParamKeys<`/${Rest}`>
    : TPath extends `${string}:${infer Param}`
      ? NormalizeParamKey<Param>
      : never

// Both derive from the path literal, so nothing about how the entries above
// are emitted can silently flip `request()`'s call arity. Deliberately not
// distributed over a union route name: the union of paths yields the union of
// their param keys, so an un-narrowed name requires every member's params —
// substituting a param a member's path lacks is a runtime no-op, while the
// reverse (accepting one member's empty params) would send a path with its
// `:param` unresolved. The one pair serves both `ApiRequestOptions` and
// `request()` below; keep them on it, or a fix lands in one spelling and not
// the other.
type PathParamsOf<TPath extends string> =
  [PathParamKeys<TPath>] extends [never]
    ? Record<string, never>
    : { [TKey in PathParamKeys<TPath>]: string | number }
type HasPathParams<TPath extends string> = [PathParamKeys<TPath>] extends [never] ? false : true

export type ApiRouteParams<T extends ApiRouteName> = PathParamsOf<ApiRoutePath<T>>

// The request body type a route declares through its bound schema — `unknown`
// for routes without one.
type BodyOf<TRoute> = TRoute extends { body: infer TBody } ? TBody : unknown

// The parsed shape a route declares through its bound output schema —
// `unknown` for routes without one.
type ResponseOf<TRoute> = TRoute extends { response: infer TResponse } ? TResponse : unknown

// The runtime object is the plain fetch `Response`; only `json()` is narrowed
// to the route's declared response shape.
export interface TypedResponse<TData> extends Response {
  json(): Promise<TData>
}

export type ApiRequestOptions<T extends ApiRouteName> =
  HasPathParams<ApiRoutePath<T>> extends false
    ? { params?: never; body?: BodyOf<ApiRoutes[T]>; query?: Record<string, unknown> }
    : { params: ApiRouteParams<T>; body?: BodyOf<ApiRoutes[T]>; query?: Record<string, unknown> }

// The wire contract these mirror is owned by Guren's CSRF middleware: it
// writes the XSRF-TOKEN cookie and reads either header name. Change them
// together.
const XSRF_COOKIE_NAME = 'XSRF-TOKEN'
const XSRF_HEADER_NAME = 'X-XSRF-TOKEN'
// QUERY (RFC 10008) is deliberately NOT listed even though the server's CSRF
// default skips it: the redundant token header is harmless there, and keeping
// it is what makes a server that opts QUERY into protection (the middleware's
// `methods` option) work with this client unchanged.
const CSRF_SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS']
const CSRF_HEADER_NAMES = [XSRF_HEADER_NAME.toLowerCase(), 'x-csrf-token']

/**
 * Read the `XSRF-TOKEN` cookie issued by Guren's CSRF middleware.
 *
 * Reached through `globalThis` so this module stays importable — and
 * type-checkable — outside the browser, where `document` does not exist.
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
 * Whether `url` targets the page's own origin.
 *
 * The `XSRF-TOKEN` cookie belongs to that origin, so it must never ride along
 * to a third-party `baseUrl`: that would hand this page's CSRF token to
 * another server, which a permissive CORS policy there is enough to accept.
 * Outside the browser there is no origin — and no cookie — so nothing is sent.
 */
function isSameOrigin(url: string): boolean {
  const location = (globalThis as { location?: { href?: string; origin?: string } }).location
  if (!location?.href || !location.origin) return false
  try {
    return new URL(url, location.href).origin === location.origin
  } catch {
    return false
  }
}

/**
 * Create a typed API client for consuming Guren routes.
 *
 * Same-origin state-changing requests automatically copy the `XSRF-TOKEN`
 * cookie into the `X-XSRF-TOKEN` header, which is what Guren's CSRF
 * middleware expects. Pass your own `X-XSRF-TOKEN` / `X-CSRF-TOKEN` header
 * to opt out — you have to, for a `baseUrl` on another origin (the cookie is
 * never sent there) or for a server configured with `csrf({ cookie: false })`.
 * Cookies follow the `credentials` option (`'same-origin'` by default; use
 * `'include'` cross-origin, with a CORS setup that allows it).
 *
 * Routes that bind a `body` schema type the `body` option with that schema's
 * request shape; routes without one accept `unknown`. Routes that bind an
 * `output` schema type the response: `json()` on the returned `Response`
 * resolves to that schema's parsed shape. Without one it resolves to
 * `unknown` — validate before trusting it.
 *
 * @example
 * ```typescript
 * import type { ApiRoutes } from '@/.guren/api-client.gen'
 *
 * const client = createApiClient<ApiRoutes>({ baseUrl: 'http://localhost:3000' })
 * const posts = await client.request('posts.index')
 * const post = await client.request('posts.show', { params: { id: 1 } })
 * ```
 */
// The mapped-object constraint (rather than `Record<...>`) is what lets the
// generated `ApiRoutes` interface satisfy it — interfaces have no implicit
// index signature, so `Record<string, ...>` would reject them.
export function createApiClient<TRoutes extends { [K in keyof TRoutes]: { method: string; path: string } }>(
  config: { baseUrl: string; headers?: Record<string, string>; credentials?: RequestInit['credentials'] },
) {
  return {
    async request<TName extends keyof TRoutes & string>(
      name: TName,
      ...args: HasPathParams<TRoutes[TName]['path']> extends false
        ? [options?: { params?: never; body?: BodyOf<TRoutes[TName]>; query?: Record<string, unknown> }]
        : [options: { params: PathParamsOf<TRoutes[TName]['path']>; body?: BodyOf<TRoutes[TName]>; query?: Record<string, unknown> }]
    ): Promise<TypedResponse<ResponseOf<TRoutes[TName]>>> {
      const route = (routes as Record<string, { method: string; path: string }>)[name]
      if (!route) throw new Error(`Route [${name}] not defined.`)

      const opts = (args as unknown[])[0] as { params?: Record<string, unknown>; body?: unknown; query?: Record<string, unknown> } | undefined
      let path = route.path
      if (opts?.params) {
        for (const [key, value] of Object.entries(opts.params)) {
          path = path.replace(`:${key}`, encodeURIComponent(String(value)))
        }
      }

      let url = `${config.baseUrl}${path}`
      if (opts?.query) {
        const search = new URLSearchParams()
        for (const [k, v] of Object.entries(opts.query)) {
          if (v != null) search.set(k, String(v))
        }
        const qs = search.toString()
        if (qs) url += `?${qs}`
      }

      const method = route.method.toUpperCase()
      const headers: Record<string, string> = { 'Content-Type': 'application/json', ...config.headers }
      if (
        !CSRF_SAFE_METHODS.includes(method) &&
        !Object.keys(headers).some((key) => CSRF_HEADER_NAMES.includes(key.toLowerCase())) &&
        isSameOrigin(url)
      ) {
        const token = readXsrfToken()
        if (token) headers[XSRF_HEADER_NAME] = token
      }

      const init: RequestInit = {
        method,
        headers,
        credentials: config.credentials ?? 'same-origin',
      }
      if (opts?.body && method !== 'GET') {
        init.body = JSON.stringify(opts.body)
      }

      return fetch(url, init)
    },
  }
}

const routes: Record<string, { method: string; path: string }> = {
  'dashboard': { method: 'GET', path: '/dashboard' },
  'home': { method: 'GET', path: '/' },
  'login': { method: 'GET', path: '/login' },
  'login.store': { method: 'POST', path: '/login' },
  'logout': { method: 'POST', path: '/logout' },
  'posts.create': { method: 'GET', path: '/posts/create' },
  'posts.destroy': { method: 'DELETE', path: '/posts/:id' },
  'posts.edit': { method: 'GET', path: '/posts/:id/edit' },
  'posts.index': { method: 'GET', path: '/posts' },
  'posts.search': { method: 'QUERY', path: '/posts/search' },
  'posts.show': { method: 'GET', path: '/posts/:id' },
  'posts.store': { method: 'POST', path: '/posts' },
  'posts.update': { method: 'PUT', path: '/posts/:id' },
  'profile.edit': { method: 'GET', path: '/profile' },
  'profile.update': { method: 'PUT', path: '/profile' },
  'register': { method: 'GET', path: '/register' },
  'register.store': { method: 'POST', path: '/register' },
}
