import type { MiddlewareHandler } from 'hono'

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
  /** Strict-Transport-Security header. Default: false (disabled) */
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
    hsts = false,
  } = options

  const hstsValue = hsts !== false ? buildHstsValue(hsts) : null

  return async (ctx, next) => {
    if (frameOptions !== false) {
      ctx.header('X-Frame-Options', frameOptions)
    }
    if (contentTypeOptions !== false) {
      ctx.header('X-Content-Type-Options', contentTypeOptions)
    }
    if (xssProtection !== false) {
      ctx.header('X-XSS-Protection', xssProtection)
    }
    if (referrerPolicy !== false) {
      ctx.header('Referrer-Policy', referrerPolicy)
    }
    if (crossDomainPolicies !== false) {
      ctx.header('X-Permitted-Cross-Domain-Policies', crossDomainPolicies)
    }
    if (hstsValue) {
      ctx.header('Strict-Transport-Security', hstsValue)
    }

    await next()
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
