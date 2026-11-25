/**
 * Which `Request` objects the agent dispatcher built (RFC 0016 §3), keyed on
 * **object identity** like the principal seam in `agent-principal.ts`: a
 * request that crosses a socket arrives as a new object and carries nothing,
 * so seeing the mark means the request was handed to `app.fetch` in this
 * process. Not `isAgentToolRequest()` in `agent-request.ts`, whose header any
 * client can send: that one only picks the shape of a refusal.
 * Not exported from the package index.
 */

import { routePathShape } from './route-path'

/** The route a dispatched request was built for, as `Router.definitions()` names it. */
export interface DispatchedToolRoute {
  method: string
  path: string
  name: string
}

const dispatched = new WeakMap<Request, DispatchedToolRoute>()

/** Mark `request` as built by `buildToolRequest` for `route`, returning that same object. */
export function markDispatchedToolRequest(request: Request, route: DispatchedToolRoute): Request {
  dispatched.set(request, { method: route.method, path: route.path, name: route.name })
  return request
}

/** Whether this exact object was built by the dispatcher in this process. */
export function isDispatchedToolRequest(request: Request): boolean {
  return dispatched.has(request)
}

/**
 * The route this exact object was built for, or `undefined` for any other
 * request. `Router.mount()` refuses it on every other route: a path parameter
 * equal to an earlier route's literal segment would otherwise run a route the
 * scope and approval gates never judged.
 */
export function readDispatchedToolRoute(request: Request): DispatchedToolRoute | undefined {
  return dispatched.get(request)
}

const routeEntries = new WeakSet<object>()

/** Record `handler` as the first handler of a route `Router.mount()` registered, returning it. */
export function markRouterRouteEntry<T extends object>(handler: T): T {
  routeEntries.add(handler)
  return handler
}

/** Whether `handler` opens a route `Router.mount()` registered, which checks the dispatched route itself. */
export function isRouterRouteEntry(handler: unknown): boolean {
  return typeof handler === 'function' && routeEntries.has(handler)
}

/**
 * The route a tool request was built for, sent by `buildToolRequest` so the guards can judge a
 * request that crossed a socket (WebMCP), where the mark above does not survive. Any client can
 * set it, so it may only refuse: a request without it, or with one that does not parse, runs
 * as it would have without the guards.
 */
export const AGENT_ROUTE_HEADER = 'X-Guren-Agent-Route'

/** The route an {@link AGENT_ROUTE_HEADER} names; `name` is absent from a header that sent none. */
export interface ClaimedToolRoute {
  method: string
  path: string
  /** {@link routePathShape} of `path`, computed once per request. */
  shape: string
  name?: string
}

/** Longer than any real tool route needs; a longer header is unreadable, so it cannot cost a shape per route. */
const MAX_AGENT_ROUTE_HEADER_LENGTH = 2048

/** The header value for `route`: URI-encoded JSON, since a path constraint may hold any character. */
export function encodeAgentRouteHeader(route: DispatchedToolRoute): string {
  return encodeURIComponent(JSON.stringify({ method: route.method, path: route.path, name: route.name }))
}

/** The route `request`'s {@link AGENT_ROUTE_HEADER} names, or `undefined` when it is absent or unreadable. */
export function readAgentRouteHeader(request: Request): ClaimedToolRoute | undefined {
  const raw = request.headers.get(AGENT_ROUTE_HEADER)
  if (raw === null || raw.length > MAX_AGENT_ROUTE_HEADER_LENGTH) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(decodeURIComponent(raw))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const { method, path, name } = parsed as Record<string, unknown>
  if (typeof method !== 'string' || typeof path !== 'string') return undefined
  return {
    method: method.toUpperCase(),
    path,
    shape: routePathShape(path),
    ...(typeof name === 'string' && name !== '' ? { name } : {}),
  }
}

/**
 * Whether `route` is the one `claimed` names, by name or by method and {@link routePathShape}.
 * Either suffices: a page built before a deploy may hold a renamed parameter, a changed
 * constraint, or a renamed route, and still mean the route it reaches.
 */
export function isClaimedRoute(claimed: ClaimedToolRoute, route: { method: string; path: string; name?: string }): boolean {
  if (claimed.name !== undefined && claimed.name === route.name) return true
  return claimed.method === route.method.toUpperCase() && claimed.shape === routePathShape(route.path)
}

/**
 * Whether `claimed` names any of `routes`. A header naming none comes from a page older than
 * the routes it calls, whose call is let through rather than refused for a route it cannot name.
 */
export function claimsRegisteredRoute(
  claimed: ClaimedToolRoute,
  routes: Iterable<{ method: string; path: string; name?: string }>,
): boolean {
  for (const route of routes) {
    if (isClaimedRoute(claimed, route)) return true
  }
  return false
}
