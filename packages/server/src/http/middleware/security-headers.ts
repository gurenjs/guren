import type { MiddlewareHandler } from 'hono'
import { applyResponseHeaders } from './response-headers'

export interface HstsOptions {
  /** Max age in seconds. */
  maxAge: number
  /** Include subdomains. Default: false */
  includeSubDomains?: boolean
  /** Enable HSTS preload. Default: false */
  preload?: boolean
}

export interface SecurityHeadersOptions {
  /** X-Frame-Options header. Set to false to disable. Default: 'SAMEORIGIN' */
  frameOptions?: string | false
  /** X-Content-Type-Options header. Set to false to disable. Default: 'nosniff' */
  contentTypeOptions?: string | false
  /** X-XSS-Protection header. Set to false to disable. Default: '0' */
  xssProtection?: string | false
  /** Referrer-Policy header. Set to false to disable. Default: 'strict-origin-when-cross-origin' */
  referrerPolicy?: string | false
  /** X-Permitted-Cross-Domain-Policies header. Set to false to disable. Default: 'none' */
  crossDomainPolicies?: string | false
  /**
   * Strict-Transport-Security header.
   * Default: `{ maxAge: 31536000 }` (1 year) when NODE_ENV is 'production', false otherwise.
   * Browsers ignore HSTS on plain-HTTP responses, so the production default is safe behind TLS terminators.
   */
  hsts?: HstsOptions | false
}

/**
 * Middleware that sets common HTTP security headers on every response.
 *
 * @example
 * ```ts
 * import { createSecurityHeaders } from '@guren/core'
 *
 * app.use('*', createSecurityHeaders())
 *
 * // With HSTS enabled
 * app.use('*', createSecurityHeaders({
 *   hsts: { maxAge: 31536000, includeSubDomains: true },
 * }))
 *
 * // Disable specific headers
 * app.use('*', createSecurityHeaders({
 *   frameOptions: false,
 *   xssProtection: false,
 * }))
 * ```
 */
export function createSecurityHeaders(options: SecurityHeadersOptions = {}): MiddlewareHandler {
  const {
    frameOptions = 'SAMEORIGIN',
    contentTypeOptions = 'nosniff',
    xssProtection = '0',
    referrerPolicy = 'strict-origin-when-cross-origin',
    crossDomainPolicies = 'none',
    hsts = process.env.NODE_ENV === 'production' ? { maxAge: 31536000 } : false,
  } = options

  const hstsValue = hsts !== false ? buildHstsValue(hsts) : null

  const headers: [string, string][] = []
  if (frameOptions !== false) headers.push(['X-Frame-Options', frameOptions])
  if (contentTypeOptions !== false) headers.push(['X-Content-Type-Options', contentTypeOptions])
  if (xssProtection !== false) headers.push(['X-XSS-Protection', xssProtection])
  if (referrerPolicy !== false) headers.push(['Referrer-Policy', referrerPolicy])
  if (crossDomainPolicies !== false) {
    headers.push(['X-Permitted-Cross-Domain-Policies', crossDomainPolicies])
  }
  if (hstsValue) headers.push(['Strict-Transport-Security', hstsValue])

  return async (ctx, next) => {
    // Applied AFTER the response exists, never with ctx.header() before next().
    // ctx.header() writes into Hono's prepared headers, which are only merged
    // when the handler answers through the context (ctx.text/json/html). A
    // handler returning a raw `new Response(...)` replaces ctx.res outright and
    // drops them — which is every asset response the framework itself serves.
    //
    // `finally`, not a plain post-next call: Hono's compose catches a thrown
    // Error in the frame that invoked the throwing handler, so `next()` usually
    // resolves and the ExceptionHandler's response is decorated like any other.
    // It does not resolve when the error escapes that frame — an exception
    // handler that throws while rendering, which Hono re-renders through this
    // same context at its outer boundary. Materializing ctx.res on the way out
    // makes these headers the base that re-render inherits.
    try {
      await next()
    } finally {
      applyResponseHeaders(ctx, headers)
    }
  }
}

function buildHstsValue(options: HstsOptions): string {
  let value = `max-age=${options.maxAge}`
  if (options.includeSubDomains) {
    value += '; includeSubDomains'
  }
  if (options.preload) {
    value += '; preload'
  }
  return value
}
