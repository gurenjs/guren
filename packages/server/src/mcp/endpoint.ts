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
 * Restricts the MCP endpoint to the developer's own machine. The endpoint is
 * CSRF-exempt (agent clients carry no token), so this guard takes over: a web
 * page is rejected unless its `Origin` is loopback, and every caller unless its
 * socket peer is. It fails closed when the runtime reports no peer at all.
 */
export function createMcpAccessGuard(): MiddlewareHandler {
  return createLoopbackGuard('the MCP endpoint')
}
