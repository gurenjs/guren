/**
 * Identity and activation rules for the dev-only MCP endpoint, which middleware
 * (CSRF) and the app bootstrap read without mounting it. The server itself lives
 * in `@guren/cli` (RFC 0028 §1).
 */
import type { MiddlewareHandler } from 'hono'
import { createLoopbackGuard } from '../http/middleware/loopback-guard'

export { isLoopbackAddress, isLoopbackOrigin } from '../http/middleware/loopback-guard'

export const MCP_ENDPOINT_PATH = '/_guren/mcp'

/** Where the Dev Center saves a plan review's feedback (RFC 0030 §8). */
export const DEV_CENTER_FEEDBACK_ROUTE = '/_guren/plans/:slug/feedback'
const DEV_CENTER_FEEDBACK_PATH = /^\/_guren\/plans\/[^/]+\/feedback$/

/** Where the Dev Center's board canvas posts its operations (RFC 0041 §2), the second write route. */
export const DEV_CENTER_BOARD_OPS_ROUTE = '/_guren/boards/:slug/ops'
const DEV_CENTER_BOARD_OPS_PATH = /^\/_guren\/boards\/[^/]+\/ops$/

/** The Dev Center's write routes with what each refuses another origin with. No other Dev Center page route takes a POST without a token. */
export const DEV_CENTER_WRITE_ROUTES = [
  { route: DEV_CENTER_FEEDBACK_ROUTE, refusal: 'Feedback is accepted from the Dev Center page only.' },
  { route: DEV_CENTER_BOARD_OPS_ROUTE, refusal: 'Board edits are accepted from the Dev Center page only.' },
] as const

/**
 * What the CSRF middleware exempts. The page posts without an `XSRF-TOKEN`: an app with no auth
 * issues none. The CLI handler requires the request's own `Origin` instead, behind the loopback
 * guard, and the routes exist only while {@link isMcpEndpointEnabled} holds.
 */
export function isDevCenterWriteRequest(path: string): boolean {
  return (DEV_CENTER_FEEDBACK_PATH.test(path) || DEV_CENTER_BOARD_OPS_PATH.test(path)) && isMcpEndpointEnabled()
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
