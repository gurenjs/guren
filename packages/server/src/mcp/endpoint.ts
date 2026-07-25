/**
 * Identity, activation rules, and access guard for the dev-only MCP endpoint.
 *
 * Kept free of MCP SDK imports so that middleware (CSRF) and the
 * application bootstrap can reason about the endpoint without pulling in
 * `@modelcontextprotocol/sdk`, which apps are not required to install.
 */
import type { Context, MiddlewareHandler } from 'hono'

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

const LOOPBACK_HOSTNAMES = new Set(['localhost', '[::1]'])
const LOOPBACK_IPV4 = /^127\.\d+\.\d+\.\d+$/

/**
 * Whether an `Origin` header value belongs to the developer's own machine.
 *
 * MCP clients are not browsers and send no `Origin` at all; a value only
 * appears when a web page made the request. Restricting those to loopback
 * blocks both ordinary cross-site requests and DNS rebinding, where an
 * attacker's domain resolves to 127.0.0.1 so the browser skips preflight.
 */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin)
    return LOOPBACK_HOSTNAMES.has(hostname) || LOOPBACK_IPV4.test(hostname)
  } catch {
    // Opaque origins ('null', from sandboxed iframes or file://) land here.
    return false
  }
}

/**
 * Whether a socket peer address belongs to this machine.
 *
 * Bun reports IPv4-mapped peers as `::ffff:127.0.0.1`, so unwrap that prefix
 * before matching.
 */
export function isLoopbackAddress(address: string): boolean {
  const normalized = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  return normalized === '::1' || LOOPBACK_IPV4.test(normalized)
}

/**
 * The peer address of the current request, when the runtime exposes one.
 *
 * `Bun.serve` passes `{ server }` through Hono's env — the same access path
 * the rate limiter uses. Proxy headers are deliberately ignored: they are
 * attacker-controlled, and this endpoint is never meant to sit behind a proxy.
 */
function clientAddress(ctx: Context): string | undefined {
  const env = ctx.env as { server?: { requestIP?: (req: Request) => { address?: string } | null } } | undefined
  if (typeof env?.server?.requestIP !== 'function') {
    return undefined
  }

  return env.server.requestIP(ctx.req.raw)?.address
}

/**
 * Restricts the MCP endpoint to the developer's own machine.
 *
 * The endpoint is exempt from CSRF — agent clients carry no token — so this
 * takes over that job, and has to cover two different callers:
 *
 * - **Web pages**, which always send `Origin`. Anything but a loopback origin
 *   is rejected, which is the check the MCP specification asks local servers
 *   for and also defeats DNS rebinding.
 * - **Non-browser clients**, which send no `Origin` and could therefore be
 *   anything on the network — dev servers bind `0.0.0.0` by default, and a
 *   `Host` header is trivially forged, so host authorization does not help.
 *   Their socket address must be loopback.
 *
 * When the runtime cannot report a peer address (non-Bun hosts, in-process
 * test requests) the address check is skipped and the origin check stands
 * alone.
 */
export function createMcpAccessGuard(): MiddlewareHandler {
  return async (ctx, next) => {
    const origin = ctx.req.header('origin')
    if (origin !== undefined && !isLoopbackOrigin(origin)) {
      return ctx.json({ message: 'Forbidden: cross-origin request to the MCP endpoint' }, 403)
    }

    const address = clientAddress(ctx)
    if (address !== undefined && !isLoopbackAddress(address)) {
      return ctx.json({ message: 'Forbidden: remote request to the MCP endpoint' }, 403)
    }

    await next()
  }
}
