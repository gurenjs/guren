/**
 * The check against Cross-Site WebSocket Hijacking. CORS does not cover a
 * WebSocket handshake and the browser sends the app's cookies with it, so a page
 * on another site could open a socket as the signed-in user. The browser sets
 * both `Origin` and `Host`, and a page elsewhere cannot make them agree.
 */
import type { Context, MiddlewareHandler } from 'hono'

export interface WebSocketOriginOptions {
  /**
   * Origins that may open a socket besides the request's own host, such as
   * `https://app.example.com` behind a proxy that rewrites `Host`.
   */
  allowedOrigins?: string[]
}

function toOrigin(value: string): string {
  let url: URL | undefined
  try {
    url = new URL(value)
  } catch {
    url = undefined
  }

  // A browser's `Origin` is always http(s), so a `wss:` entry could never match.
  if (url?.protocol !== 'http:' && url?.protocol !== 'https:') {
    throw new Error(`allowedOrigins entry "${value}" is not an http(s) origin such as https://app.example.com`)
  }
  return url.origin
}

/**
 * Hosts are compared, not schemes: TLS usually ends at a proxy, so the app sees
 * `http:`. No `Origin` is not a browser and carries no ambient cookies; `null`
 * (sandboxed frames, file://) fails to parse and is refused.
 */
export function webSocketOriginCheck(allowedOrigins: string[] = []): (ctx: Context) => boolean {
  const allowed = new Set(allowedOrigins.map(toOrigin))

  return (ctx) => {
    const origin = ctx.req.header('origin')
    if (origin === undefined) return true

    let parsed: URL
    try {
      parsed = new URL(origin)
    } catch {
      return false
    }

    return allowed.has(parsed.origin) || parsed.host === new URL(ctx.req.url).host
  }
}

/** Refuses, with 403, a request whose `Origin` is neither the app's own host nor listed. */
export function createWebSocketOriginGuard(options: WebSocketOriginOptions = {}): MiddlewareHandler {
  const isAllowed = webSocketOriginCheck(options.allowedOrigins)

  return async (ctx, next) => {
    if (!isAllowed(ctx)) {
      return ctx.json({ message: 'Forbidden: cross-origin WebSocket upgrade' }, 403)
    }
    await next()
  }
}
