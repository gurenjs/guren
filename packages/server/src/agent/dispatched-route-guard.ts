import type { Context, MiddlewareHandler } from 'hono'
import { matchedRoutes } from 'hono/route'

import type { RouteDefinition, Router } from '../mvc/Router'
import { tryGetRequestContainer } from '../http/request-container'
import {
  AGENT_ROUTE_HEADER,
  claimsRegisteredRoute,
  isRouterRouteEntry,
  readAgentRouteHeader,
  readDispatchedToolRoute,
  type ClaimedToolRoute,
  type DispatchedToolRoute,
} from '../internal/dispatched-request'

/**
 * The 400 a dispatched tool call gets when a route other than its own would answer it.
 * A refusal read off {@link AGENT_ROUTE_HEADER} is never stored: the same URL without the
 * header, or with another one, runs.
 */
export function refuseMisroutedToolCall(
  c: Context,
  target: DispatchedToolRoute | ClaimedToolRoute,
  options: { fromHeader?: boolean } = {},
): Response {
  const body = {
    message:
      `The tool call reached a different route than the tool's own (${target.method} ${target.path}), `
      + 'so nothing was run. A path parameter equal to another route\'s literal segment selects that route.',
  }
  if (!options.fromHeader) return c.json(body, 400)
  return c.json(body, 400, { 'Cache-Control': 'no-store', Vary: AGENT_ROUTE_HEADER })
}

/**
 * Registered by `Application` ahead of every other handler. `Router.mount()` guards its own
 * routes, but a route added straight to Hono (`hono.get()` in `createApp({ boot })`, which runs
 * before the routes mount) carries no guard, so a dispatched request whose first matched route
 * is one of those is refused here, before it runs. An `ALL` entry is passed over as middleware:
 * Hono records `use()` and `all()` alike, so a `hono.all()` route ahead of the tool's is not seen.
 */
export function guardDispatchedToolRoutes(): MiddlewareHandler {
  return async function guardDispatchedToolRoutes(c, next) {
    const target = readDispatchedToolRoute(c.req.raw)
    if (target === undefined) return guardClaimedToolRoute(c, next)
    for (const entry of matchedRoutes(c).slice(c.req.routeIndex + 1)) {
      if (isRouterRouteEntry(entry.handler)) break
      if (entry.method !== 'ALL') return refuseMisroutedToolCall(c, target)
    }
    return next()
  }
}

/**
 * The same walk for a request carrying {@link AGENT_ROUTE_HEADER} and no mark, which refuses
 * less: a Hono entry passes when its path answers every request of the tool's pattern, as the
 * page sent it or as the route of that name now reads (a `/posts/*` or a plain `/posts/:x`
 * ahead of `/posts/:id{[0-9]+}`), and so does a header naming no route the router holds.
 */
async function guardClaimedToolRoute(c: Context, next: () => Promise<void>): Promise<Response | void> {
  const claimed = readAgentRouteHeader(c.req.raw)
  if (claimed === undefined) return next()
  let routes: RouteDefinition[] | undefined
  const registered = () => (routes ??= tryGetRequestContainer(c)?.makeOptional<Router>('router')?.definitions() ?? [])
  for (const entry of matchedRoutes(c).slice(c.req.routeIndex + 1)) {
    if (isRouterRouteEntry(entry.handler)) break
    if (entry.method === 'ALL' || entry.method.toUpperCase() !== claimed.method) continue
    if (pathCovers(entry.path, claimed.path)) continue
    const live = claimed.name === undefined ? undefined : registered().find((route) => route.name === claimed.name)
    if (live !== undefined && pathCovers(entry.path, live.path)) continue
    if (!claimsRegisteredRoute(claimed, registered())) return next()
    return refuseMisroutedToolCall(c, claimed, { fromHeader: true })
  }
  return next()
}

/**
 * Whether every URL the pattern `target` builds also matches `entry`, segment by segment and
 * failing closed. Parameter labels never count, a constraint must be the same one (or admit the
 * literal it meets), and a trailing `*` covers whatever is left, nothing included, as in Hono.
 * A tool's `:x?` is always filled, since `buildToolRequest` refuses a call that omits it.
 */
export function pathCovers(entry: string, target: string): boolean {
  const entrySegments = splitPath(entry)
  const targetSegments = splitPath(target)
  for (let index = 0; index < entrySegments.length; index++) {
    const segment = entrySegments[index]!
    const last = index === entrySegments.length - 1
    if (segment === '*' && last) return true
    const against = targetSegments[index]
    if (against === undefined) return last && isParam(segment) && segment.endsWith('?')
    if (!segmentCovers(segment, against)) return false
  }
  return entrySegments.length === targetSegments.length
}

function segmentCovers(entry: string, target: string): boolean {
  if (entry === '*') return true
  if (!isParam(entry)) return entry === target
  const constraint = constraintOf(entry)
  if (constraint === undefined) return true
  if (isParam(target)) return constraintOf(target) === constraint
  try {
    // No `u` flag: Hono compiles constraints without it, and `[\w-]` is a syntax error under it.
    return new RegExp(`^(?:${constraint})$`).test(target)
  } catch {
    return false
  }
}

function isParam(segment: string): boolean {
  return segment.startsWith(':')
}

function constraintOf(segment: string): string | undefined {
  const open = segment.indexOf('{')
  if (open === -1) return undefined
  const close = segment.lastIndexOf('}')
  return close > open ? segment.slice(open + 1, close) : undefined
}

/** Split on `/` outside a `{…}` constraint, which may itself hold one. */
function splitPath(path: string): string[] {
  const segments: string[] = []
  let depth = 0
  let current = ''
  for (const char of path.replace(/^\//u, '')) {
    if (char === '{') depth++
    else if (char === '}') depth = Math.max(0, depth - 1)
    if (char === '/' && depth === 0) {
      segments.push(current)
      current = ''
    } else {
      current += char
    }
  }
  segments.push(current)
  return segments
}
