/**
 * Loopback-only access guard shared by the dev-only framework endpoints
 * (`/_guren/mcp`, `/_guren/docs`). Two classes of caller are stopped (see
 * `.claude/rules/common-pitfalls.md`): browser pages, rejected unless `Origin`
 * is loopback (also defeats DNS rebinding), and non-browser clients, rejected
 * unless the socket peer is loopback — templates bind `0.0.0.0`, `Host` is
 * trivially forged, and a client sending no `Origin` looks like a local process.
 * Fails closed: no reported peer is denied ("no `Origin`, no peer" is a remote
 * `curl`); peer-less runtimes (Node, `app.fetch()`) need `GUREN_ALLOW_UNVERIFIED_PEER=1`.
 */
import type { Context, MiddlewareHandler } from 'hono'

const LOOPBACK_HOSTNAMES = new Set(['localhost', '[::1]'])
const LOOPBACK_IPV4 = /^127\.\d+\.\d+\.\d+$/

/**
 * Whether an `Origin` header value belongs to the developer's own machine.
 * Only a web page's request carries one; restricting it to loopback blocks
 * cross-site requests and DNS rebinding (an attacker's domain resolving to
 * 127.0.0.1 so the browser skips preflight). A *negative* filter only: any
 * non-browser client sets the header with one flag, so never use it to satisfy the peer check.
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
 * `Bun.serve` passes `{ server }` through Hono's env, wired by
 * `Application.listen()`; proxy headers are attacker-controlled and ignored.
 * `undefined` means "the runtime did not say", not "remote": no `server` in env
 * (Node, Vercel's `app.fetch(request)`, in-process tests), or `requestIP()` null (closed or non-TCP socket).
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
 * Restricts an endpoint to the developer's own machine. `resource` names the
 * endpoint in the 403 body (e.g. "the MCP endpoint"). The two denials say
 * different things on purpose: a present non-loopback peer is a remote caller,
 * a peer the runtime never reported is a deployment the guard cannot vouch for.
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
