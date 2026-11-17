import type { Context, MiddlewareHandler } from 'hono'
import { matchedRoutes } from 'hono/route'

import { isRouterRouteEntry, readDispatchedToolRoute, type DispatchedToolRoute } from '../internal/dispatched-request'

/** The 400 a dispatched tool call gets when a route other than its own would answer it. */
export function refuseMisroutedToolCall(c: Context, target: DispatchedToolRoute): Response {
  return c.json({
    message:
      `The tool call reached a different route than the tool's own (${target.method} ${target.path}), `
      + 'so nothing was run. A path parameter equal to another route\'s literal segment selects that route.',
  }, 400)
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
    if (target === undefined) return next()
    for (const entry of matchedRoutes(c).slice(c.req.routeIndex + 1)) {
      if (isRouterRouteEntry(entry.handler)) break
      if (entry.method !== 'ALL') return refuseMisroutedToolCall(c, target)
    }
    return next()
  }
}
