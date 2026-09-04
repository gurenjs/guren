import type { MiddlewareHandler } from 'hono'
import {
  hostMatchesAllowlist,
  isAppRelativePath,
  normalizeRedirectTarget,
} from '../../support/redirect-target'

export interface RedirectSafetyOptions {
  /** Additional external hosts allowed as redirect targets. */
  allowedHosts?: string[]
  /** Fallback URL when an unsafe redirect is blocked. Default: '/' */
  fallbackUrl?: string
}

/** Prevents open redirects by validating the `Location` of every 3xx response. */
export function createRedirectSafetyMiddleware(options: RedirectSafetyOptions = {}): MiddlewareHandler {
  const { allowedHosts = [], fallbackUrl = '/' } = options

  return async (ctx, next) => {
    await next()

    const res = ctx.res
    const status = res.status

    if (status < 300 || status >= 400) return

    const location = res.headers.get('Location')
    if (!location) return

    const requestUrl = ctx.req.url
    if (!isSafeRedirectUrl(location, requestUrl, allowedHosts)) {
      const headers = new Headers(res.headers)
      headers.set('Location', fallbackUrl)
      ctx.res = undefined as unknown as Response
      ctx.res = new Response(res.body, { status, headers })
    }
  }
}

/** Safe means same-origin as `requestUrl`, or a host in `allowedHosts`. */
export function isSafeRedirectUrl(
  url: string,
  requestUrl: string,
  allowedHosts: string[] = [],
): boolean {
  const normalized = normalizeRedirectTarget(url)

  if (isAppRelativePath(normalized)) {
    return true
  }

  // Protocol-relative URLs (//evil.com) are treated as absolute
  try {
    const target = new URL(normalized, requestUrl)
    const current = new URL(requestUrl)

    if (target.host === current.host && target.protocol === current.protocol) {
      return true
    }

    return hostMatchesAllowlist(target, allowedHosts)
  } catch {
    return false
  }
}
