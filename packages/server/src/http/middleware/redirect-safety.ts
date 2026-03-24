import type { MiddlewareHandler } from 'hono'

export interface RedirectSafetyOptions {
  /** Additional external hosts allowed as redirect targets. */
  allowedHosts?: string[]
  /** Fallback URL when an unsafe redirect is blocked. Default: '/' */
  fallbackUrl?: string
}

/**
 * Middleware that prevents open redirect attacks by validating
 * redirect destinations in 3xx responses.
 *
 * @example
 * ```ts
 * import { createRedirectSafetyMiddleware } from '@guren/core'
 *
 * app.use('*', createRedirectSafetyMiddleware({
 *   allowedHosts: ['accounts.google.com'],
 * }))
 * ```
 */
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

/**
 * Check whether a redirect URL is safe (same-origin or in the allowed list).
 *
 * @param url - The redirect target URL
 * @param requestUrl - The current request URL (used to determine the origin)
 * @param allowedHosts - Additional allowed external hosts
 */
export function isSafeRedirectUrl(
  url: string,
  requestUrl: string,
  allowedHosts: string[] = [],
): boolean {
  // Normalize backslash tricks (e.g., \/evil.com)
  const normalized = url.replace(/\\/g, '/')

  // Relative URLs starting with a single slash are always safe
  if (normalized.startsWith('/') && !normalized.startsWith('//')) {
    return true
  }

  // Protocol-relative URLs (//evil.com) are treated as absolute
  try {
    const target = new URL(normalized, requestUrl)
    const current = new URL(requestUrl)

    // Same origin check
    if (target.host === current.host && target.protocol === current.protocol) {
      return true
    }

    // Check allowed hosts
    for (const allowed of allowedHosts) {
      if (allowed.startsWith('*.')) {
        const suffix = allowed.slice(1).toLowerCase()
        if (target.hostname.toLowerCase().endsWith(suffix) && target.hostname.length > suffix.length) {
          return true
        }
      } else if (target.host.toLowerCase() === allowed.toLowerCase()) {
        return true
      }
    }
  } catch {
    // Malformed URLs are not safe
    return false
  }

  return false
}
