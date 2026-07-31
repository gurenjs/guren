/**
 * Identity and activation rules for the dev-only MCP endpoint.
 *
 * Kept free of MCP SDK imports so that middleware (CSRF) and the
 * application bootstrap can reason about the endpoint without pulling in
 * `@modelcontextprotocol/sdk`, which apps are not required to install.
 * The loopback access guard itself is shared with the docs viewer — see
 * `http/middleware/loopback-guard.ts`.
 */
import type { MiddlewareHandler } from 'hono'
import { createLoopbackGuard } from '../http/middleware/loopback-guard'

export { isLoopbackAddress, isLoopbackOrigin } from '../http/middleware/loopback-guard'

export const MCP_ENDPOINT_PATH = '/_guren/mcp'

/**
 * Whether the MCP endpoint is mounted for this process.
 *
 * Opt-in via `GUREN_MCP=1` and never active in production: the endpoint
 * exposes project introspection and code generation, so it must not be
 * reachable unless the developer asked for it.
 */
export function isMcpEndpointEnabled(): boolean {
  return (
    typeof process !== 'undefined' &&
    process.env?.NODE_ENV !== 'production' &&
    process.env?.GUREN_MCP === '1'
  )
}

/**
 * Restricts the MCP endpoint to the developer's own machine.
 *
 * The endpoint is exempt from CSRF — agent clients carry no token — so
 * the loopback guard takes over that job: web pages are rejected unless
 * their `Origin` is loopback (the check the MCP specification asks local
 * servers for), and non-browser clients unless their socket peer is.
 */
export function createMcpAccessGuard(): MiddlewareHandler {
  return createLoopbackGuard('the MCP endpoint')
}
