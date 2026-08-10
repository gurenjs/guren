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
 *
 * The environment reads below are deliberately written as plain member
 * access. Do not "harden" them with optional chaining: the deploy plugins
 * bundle server code with `--define 'process.env.NODE_ENV="production"'`,
 * and a define matches one exact expression. Inserting `?.` produces a
 * different expression that no define touches, leaving this gate a runtime
 * read — and on hosts where the platform's environment is not in
 * `process.env` by the time the module graph evaluates (workerd is the
 * documented case; see the comment on the Cloudflare plugin's `define`),
 * that runtime read answers "not production" and the gate silently reopens.
 * A test in `tests/mcp/endpoint.test.ts` reads this file and fails on any
 * optional chain after `process.env`, because nothing observable at runtime
 * distinguishes the two forms.
 *
 * The `typeof process` check covers the only runtimes without `process`;
 * every runtime the framework supports that has `process` has `process.env`.
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
 * Restricts the MCP endpoint to the developer's own machine.
 *
 * The endpoint is exempt from CSRF — agent clients carry no token — so
 * the loopback guard takes over that job: web pages are rejected unless
 * their `Origin` is loopback (the check the MCP specification asks local
 * servers for), and every caller is rejected unless its socket peer is
 * loopback. The guard fails closed when the runtime reports no peer at
 * all; see `http/middleware/loopback-guard.ts` for the opt-out.
 */
export function createMcpAccessGuard(): MiddlewareHandler {
  return createLoopbackGuard('the MCP endpoint')
}
