/**
 * Identity and activation rules for the dev-only MCP endpoint, which middleware
 * (CSRF) and the app bootstrap read without mounting it. The server itself lives
 * in `@guren/cli` (RFC 0028 §1).
 */
import type { MiddlewareHandler } from 'hono'
import { createLoopbackGuard } from '../http/middleware/loopback-guard'

export { isLoopbackAddress, isLoopbackOrigin } from '../http/middleware/loopback-guard'

export const MCP_ENDPOINT_PATH = '/_guren/mcp'

/** Where the Dev Center saves a plan review's feedback (RFC 0030 §8), its one write route. */
export const DEV_CENTER_FEEDBACK_ROUTE = '/_guren/plans/:slug/feedback'
const DEV_CENTER_FEEDBACK_PATH = /^\/_guren\/plans\/[^/]+\/feedback$/

/**
 * The page posts without an `XSRF-TOKEN`: an app with no auth issues none. The CLI handler
 * requires the request's own `Origin` instead, behind the loopback guard, and the route
 * exists only while {@link isMcpEndpointEnabled} holds.
 */
export function isDevCenterFeedbackRequest(path: string): boolean {
  return DEV_CENTER_FEEDBACK_PATH.test(path) && isMcpEndpointEnabled()
}

/**
 * Whether the MCP endpoint is mounted: opt-in via `GUREN_MCP=1`, never in
 * production (it exposes project introspection and code generation). The env
 * reads are plain member access on purpose: the deploy plugins settle NODE_ENV
 * with `--define`, which matches one exact expression, so an optional chain
 * leaves a runtime read that reopens the gate on workerd; `tests/mcp/endpoint.test.ts` pins the form.
 */
export function isMcpEndpointEnabled(): boolean {
  if (typeof process === 'undefined') {
    return false
  }
  if (process.env.NODE_ENV === 'production') {
    return false
  }

  return process.env.GUREN_MCP === '1'
}

/**
 * Restricts the MCP endpoint to the developer's own machine. The endpoint is
 * CSRF-exempt (agent clients carry no token), so this guard takes over: a web
 * page is rejected unless its `Origin` is loopback, and every caller unless its
 * socket peer is. It fails closed when the runtime reports no peer at all.
 */
export function createMcpAccessGuard(): MiddlewareHandler {
  return createLoopbackGuard('the MCP endpoint')
}
