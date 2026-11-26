import type { Context } from 'hono'
import { matchedRoutes } from 'hono/route'
import { isRouterRouteEntry } from './dispatched-request'

/**
 * Whether a `Router` route matching this request (`POST /:slug` at `/mcp`) sits ahead of the
 * endpoint at `endpointRoute`, the last entry Hono matched at that registered path that is no
 * Router route. Only Router entries count: Hono records `hono.post('*', mw)` as a route too, so
 * counting raw entries would refuse the endpoint's own callers. A route added straight to Hono
 * ahead of the endpoint is not seen.
 */
export function routerRouteAnswersAhead(ctx: Context, endpointRoute: string): boolean {
  // Only a context Hono did not dispatch (a test double) lacks it, and no Router route answered that one.
  if (typeof ctx.req.routeIndex !== 'number') return false
  const entries = matchedRoutes(ctx)
  let endpoint = entries.length
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!
    if (entry.path === endpointRoute && !isRouterRouteEntry(entry.handler)) {
      endpoint = index
      break
    }
  }
  // From the first entry, not the caller's own: a guard running inside the Router route that answers sits after its entry.
  return entries.slice(0, endpoint).some((entry) => isRouterRouteEntry(entry.handler))
}
