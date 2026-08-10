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
 *
 * The guard fails closed. A request is served only once the runtime has
 * reported a loopback peer; if it reports no peer at all, the request is
 * denied rather than waved through, because "no `Origin` and no peer" is
 * exactly the shape of a remote `curl`. Runtimes that cannot report a peer
 * (Node, or any host calling `app.fetch()` directly instead of
 * `Application.listen()`) need `GUREN_ALLOW_UNVERIFIED_PEER=1`, which the
 * denial names.
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
 *
 * This is a *negative* filter only. A loopback `Origin` is never proof that
 * the caller is local: browsers set the header honestly, but any other
 * client sets it with one flag. Never use it to satisfy the peer check.
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
 * the rate limiter uses, and the one `Application.listen()` wires up. Proxy
 * headers are deliberately ignored: they are attacker-controlled, and these
 * endpoints are never meant to sit behind a proxy.
 *
 * `undefined` means "this runtime did not tell us", not "the peer is
 * remote": either the host never passed a `server` through (Node, Vercel's
 * `app.fetch(request)`, in-process test requests), or `requestIP()` itself
 * returned `null`, which Bun does for a socket that is already closed or is
 * not TCP.
 */
function clientAddress(ctx: Context): string | undefined {
  const env = ctx.env as { server?: { requestIP?: (req: Request) => { address?: string } | null } } | undefined
  if (typeof env?.server?.requestIP !== 'function') {
    return undefined
  }

  return env.server.requestIP(ctx.req.raw)?.address
}

/**
 * Whether the operator accepted serving these endpoints on a runtime that
 * cannot report the socket peer.
 *
 * Read per request, and written in the plain `process.env.X` form for the
 * same bundler reason as the endpoint gates (see `mcp/endpoint.ts`).
 */
function allowsUnverifiedPeer(): boolean {
  return typeof process !== 'undefined' && process.env.GUREN_ALLOW_UNVERIFIED_PEER === '1'
}

/**
 * Restricts an endpoint to the developer's own machine. `resource` names
 * the endpoint in the 403 body (e.g. "the MCP endpoint").
 *
 * Three outcomes, and the two denials say different things on purpose:
 * a peer that is present and not loopback is a remote caller, while a peer
 * the runtime never reported is a deployment the guard cannot vouch for —
 * the developer needs to know which one they are looking at.
 */
export function createLoopbackGuard(resource: string): MiddlewareHandler {
  return async (ctx, next) => {
    const origin = ctx.req.header('origin')
    if (origin !== undefined && !isLoopbackOrigin(origin)) {
      return ctx.json({ message: `Forbidden: cross-origin request to ${resource}` }, 403)
    }

    // The peer check runs whatever the origin said: a loopback `Origin` is
    // forgeable by everything that is not a browser, so it can never stand in
    // for it.
    const address = clientAddress(ctx)

    if (address !== undefined && !isLoopbackAddress(address)) {
      return ctx.json({ message: `Forbidden: remote request to ${resource}` }, 403)
    }

    if (address === undefined && !allowsUnverifiedPeer()) {
      return ctx.json(
        {
          message:
            `Forbidden: this runtime does not report the peer address, so ${resource} ` +
            'cannot confirm the request came from this machine. Serve the app with ' +
            'Application.listen() on Bun, or set GUREN_ALLOW_UNVERIFIED_PEER=1 to accept ' +
            'requests from anywhere the process is reachable.',
        },
        403,
      )
    }

    await next()
  }
}
