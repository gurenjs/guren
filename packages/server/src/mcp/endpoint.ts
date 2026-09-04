/**
 * Identity and activation rules for the dev-only MCP endpoint. Free of MCP SDK
 * imports so middleware (CSRF) and the app bootstrap can reason about the
 * endpoint without `@modelcontextprotocol/sdk`, which apps need not install.
 */
import type { MiddlewareHandler } from 'hono'
import { createLoopbackGuard } from '../http/middleware/loopback-guard'

export { isLoopbackAddress, isLoopbackOrigin } from '../http/middleware/loopback-guard'

export const MCP_ENDPOINT_PATH = '/_guren/mcp'

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
