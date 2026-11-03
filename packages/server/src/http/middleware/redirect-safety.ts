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

/**
 * The path of a `Referer` on one of `acceptedHosts` (as `URL.host` spells them,
 * port included), for redirecting back, or `fallback`. A relative Referer resolves
 * against `requestUrl`. The scheme is not compared: behind a TLS-terminating proxy
 * the request reads `http:` while the browser's Referer reads `https:`. Only the
 * path and query are kept, so the browser stays on its own origin.
 */
export function sameHostRefererPath(
  referer: string | undefined,
  requestUrl: string,
  acceptedHosts: readonly string[],
  fallback = '/',
): string {
  if (!referer) return fallback

  try {
    const target = new URL(referer, requestUrl)
    if ((target.protocol !== 'http:' && target.protocol !== 'https:') || !acceptedHosts.includes(target.host)) {
      return fallback
    }

    // `http://host//evil.example` has the path `//evil.example`, which a browser
    // reads as another host. The query is left as sent.
    const pathname = normalizeRedirectTarget(target.pathname)
    return isAppRelativePath(pathname) ? `${pathname}${target.search}` : fallback
  } catch {
    return fallback
  }
}
