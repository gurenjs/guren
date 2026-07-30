/**
 * Loopback-only access guard shared by the dev-only framework endpoints
 * (`/_guren/mcp`, `/_guren/docs`).
 *
 * Two classes of caller have to be stopped (see
 * `.claude/rules/common-pitfalls.md`): browser pages, rejected unless
 * their `Origin` is loopback (which also defeats DNS rebinding), and
 * non-browser clients, rejected unless the socket peer is loopback —
 * templates bind `0.0.0.0` and `Host` is trivially forged, so host
 * authorization does not help, and a client that sends no `Origin` is
 * otherwise indistinguishable from a local process.
 */
import type { Context, MiddlewareHandler } from 'hono'

const LOOPBACK_HOSTNAMES = new Set(['localhost', '[::1]'])
const LOOPBACK_IPV4 = /^127\.\d+\.\d+\.\d+$/

/**
 * Whether an `Origin` header value belongs to the developer's own machine.
 *
 * Non-browser clients send no `Origin` at all; a value only appears when a
 * web page made the request. Restricting those to loopback blocks both
 * ordinary cross-site requests and DNS rebinding, where an attacker's
 * domain resolves to 127.0.0.1 so the browser skips preflight.
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
 * attacker-controlled, and these endpoints are never meant to sit behind a
 * proxy.
 */
function clientAddress(ctx: Context): string | undefined {
  const env = ctx.env as { server?: { requestIP?: (req: Request) => { address?: string } | null } } | undefined
  if (typeof env?.server?.requestIP !== 'function') {
    return undefined
  }

  return env.server.requestIP(ctx.req.raw)?.address
}

/**
 * Restricts an endpoint to the developer's own machine. `resource` names
 * the endpoint in the 403 body (e.g. "the MCP endpoint").
 *
 * When the runtime cannot report a peer address (non-Bun hosts, in-process
 * test requests) the address check is skipped and the origin check stands
 * alone.
 */
export function createLoopbackGuard(resource: string): MiddlewareHandler {
  return async (ctx, next) => {
    const origin = ctx.req.header('origin')
    if (origin !== undefined && !isLoopbackOrigin(origin)) {
      return ctx.json({ message: `Forbidden: cross-origin request to ${resource}` }, 403)
    }

    const address = clientAddress(ctx)
    if (address !== undefined && !isLoopbackAddress(address)) {
      return ctx.json({ message: `Forbidden: remote request to ${resource}` }, 403)
    }

    await next()
  }
}
