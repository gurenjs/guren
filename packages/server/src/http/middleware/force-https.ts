import type { MiddlewareHandler } from 'hono'
import { applyResponseHeaders } from './response-headers'
import { isDispatchedToolRequest } from '../../internal/dispatched-request'

export interface ForceHttpsOptions {
  /** Seconds. Default: 31536000 (1 year). */
  hstsMaxAge?: number
  /** Default: true. */
  hstsIncludeSubDomains?: boolean
  /** Default: false. */
  hstsPreload?: boolean
  /** Paths exempt from the redirect; a trailing `*` matches a prefix. */
  exclude?: string[]
}

/**
 * Redirects HTTP to HTTPS and sets Strict-Transport-Security. Equivalent to
 * Rails' `force_ssl`. An agent tool call the dispatcher re-enters in process
 * passes through.
 */
export function createForceHttpsMiddleware(options: ForceHttpsOptions = {}): MiddlewareHandler {
  const {
    hstsMaxAge = 31536000,
    hstsIncludeSubDomains = true,
    hstsPreload = false,
    exclude = [],
  } = options

  let hstsValue = `max-age=${hstsMaxAge}`
  if (hstsIncludeSubDomains) hstsValue += '; includeSubDomains'
  if (hstsPreload) hstsValue += '; preload'

  return async (ctx, next) => {
    const url = new URL(ctx.req.url)
    const proto = ctx.req.header('x-forwarded-proto') ?? url.protocol.replace(':', '')

    if (proto !== 'https') {
      const path = url.pathname + url.search
      const excluded = exclude.some((pattern) =>
        pattern.endsWith('*') ? path.startsWith(pattern.slice(0, -1)) : path === pattern,
      )
      // A tool call never leaves the process, so there is no transport to upgrade, and a
      // tool caller cannot follow a redirect. By identity, never by a header.
      if (excluded || isDispatchedToolRequest(ctx.req.raw)) {
        await next()
        return
      }

      url.protocol = 'https:'
      return ctx.redirect(url.toString(), 301)
    }

    // After next(), not ctx.header() before it: a handler returning a raw
    // Response drops Hono's prepared headers, which is every static asset the
    // framework serves. See applyResponseHeaders.
    try {
      await next()
    } finally {
      applyResponseHeaders(ctx, [['Strict-Transport-Security', hstsValue]])
    }
  }
}
