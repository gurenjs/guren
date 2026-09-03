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
 * Validates the Host header against an allowed list, guarding against DNS
 * rebinding and host header attacks.
 */
export function createHostAuthorizationMiddleware(options: HostAuthorizationOptions): MiddlewareHandler {
  const { allowedHosts, exclude = [], onError } = options
  const matchers = allowedHosts.map(compileHostMatcher)

  return async (ctx, next) => {
    // Hono already parsed and cached this; re-parsing the whole URL here costs
    // more than the rest of the check put together, on every request.
    const path = ctx.req.path

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

/** Strips the port, keeping an IPv6 literal's brackets (`[::1]:3000`). */
function extractHostname(host: string): string {
  if (host.startsWith('[')) {
    const bracketEnd = host.indexOf(']')
    return bracketEnd !== -1 ? host.slice(0, bracketEnd + 1) : host
  }
  const colonIndex = host.lastIndexOf(':')
  return colonIndex !== -1 ? host.slice(0, colonIndex) : host
}

function compileHostMatcher(pattern: string): HostMatcher {
  // `*.example.com`. Matched against the hostname with the port stripped, or
  // `attacker.com:80.example.com` would pass.
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1).toLowerCase()
    return (host) => {
      const hostname = extractHostname(host).toLowerCase()
      return hostname.endsWith(suffix) && hostname.length > suffix.length
    }
  }

  if (pattern.endsWith(':*')) {
    const hostname = pattern.slice(0, -2).toLowerCase()
    return (host) => {
      const h = host.toLowerCase()
      if (h === hostname) return true
      if (!h.startsWith(hostname + ':')) return false
      // The wildcard stands for a port, so only a port may follow. Accepting
      // anything made `example.com:attacker.tld` match `example.com:*`.
      return /^\d+$/.test(h.slice(hostname.length + 1))
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
