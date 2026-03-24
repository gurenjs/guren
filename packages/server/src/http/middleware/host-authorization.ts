import type { Context, MiddlewareHandler } from 'hono'

export interface HostAuthorizationOptions {
  /** Allowed hosts. Supports exact matches and wildcard subdomains (e.g., '*.example.com'). */
  allowedHosts: string[]
  /** Paths to exclude from host checking (e.g., ['/healthcheck', '/up']). */
  exclude?: string[]
  /** Custom response when host is not authorized. Default: 403 Forbidden. */
  onError?: (ctx: Context) => Response | Promise<Response>
}

/**
 * Middleware that validates the Host header against an allowed list.
 * Protects against DNS rebinding and host header attacks.
 *
 * @example
 * ```ts
 * import { createHostAuthorizationMiddleware } from '@guren/core'
 *
 * app.use('*', createHostAuthorizationMiddleware({
 *   allowedHosts: ['example.com', '*.example.com', 'localhost:3000'],
 *   exclude: ['/healthcheck'],
 * }))
 * ```
 */
export function createHostAuthorizationMiddleware(options: HostAuthorizationOptions): MiddlewareHandler {
  const { allowedHosts, exclude = [], onError } = options
  const matchers = allowedHosts.map(compileHostMatcher)

  return async (ctx, next) => {
    const path = new URL(ctx.req.url).pathname

    if (isExcluded(path, exclude)) {
      await next()
      return
    }

    const host = ctx.req.header('host') ?? new URL(ctx.req.url).host

    if (!matchesAny(host, matchers)) {
      if (onError) {
        const response = await onError(ctx)
        return response
      }
      return ctx.text('Forbidden: Invalid Host header', 403)
    }

    await next()
  }
}

type HostMatcher = (host: string) => boolean

/**
 * Extract the hostname portion from a host header value (strip port).
 */
function extractHostname(host: string): string {
  // Handle IPv6: [::1]:3000
  if (host.startsWith('[')) {
    const bracketEnd = host.indexOf(']')
    return bracketEnd !== -1 ? host.slice(0, bracketEnd + 1) : host
  }
  const colonIndex = host.lastIndexOf(':')
  return colonIndex !== -1 ? host.slice(0, colonIndex) : host
}

function compileHostMatcher(pattern: string): HostMatcher {
  // Wildcard subdomain: *.example.com
  // Matches against hostname only (port stripped) to prevent
  // port-embedded host tricks like "attacker.com:80.example.com"
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1).toLowerCase() // e.g., '.example.com'
    return (host) => {
      const hostname = extractHostname(host).toLowerCase()
      return hostname.endsWith(suffix) && hostname.length > suffix.length
    }
  }

  // Port wildcard: localhost:*
  if (pattern.endsWith(':*')) {
    const hostname = pattern.slice(0, -2).toLowerCase()
    return (host) => {
      const h = host.toLowerCase()
      return h === hostname || h.startsWith(hostname + ':')
    }
  }

  const lower = pattern.toLowerCase()
  return (host) => host.toLowerCase() === lower
}

function matchesAny(host: string, matchers: HostMatcher[]): boolean {
  for (const matcher of matchers) {
    if (matcher(host)) return true
  }
  return false
}

function isExcluded(path: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern.endsWith('*')) {
      if (path.startsWith(pattern.slice(0, -1))) return true
    } else if (path === pattern) {
      return true
    }
  }
  return false
}
