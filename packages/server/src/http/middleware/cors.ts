import type { MiddlewareHandler } from 'hono'
import { cors } from 'hono/cors'

export interface CorsOptions {
  /** Allowed origins. Default: none, so the same-origin policy applies. */
  origin?: string | string[] | ((origin: string, ctx: unknown) => string | undefined | null)
  /** Allowed HTTP methods. Default: ['GET', 'HEAD', 'PUT', 'POST', 'DELETE', 'PATCH', 'QUERY'] */
  allowMethods?: string[]
  allowHeaders?: string[]
  exposeHeaders?: string[]
  /** Preflight cache, in seconds. */
  maxAge?: number
  /** Cookies and Authorization headers. Default: false */
  credentials?: boolean
}

// Guren owns this default: the supported Hono range (^4.12.29) starts before
// Hono's own list gained QUERY, and Hono spreads caller options over its
// defaults, so a key passed as `undefined` erases the default entirely.
const DEFAULT_ALLOW_METHODS = ['GET', 'HEAD', 'PUT', 'POST', 'DELETE', 'PATCH', 'QUERY']

/** CORS middleware powered by Hono's built-in CORS support. */
export function createCorsMiddleware(options: CorsOptions = {}): MiddlewareHandler {
  if (options.credentials && !options.origin) {
    throw new Error(
      'CORS: credentials requires an explicit origin. ' +
      'Wildcard origin (*) with credentials is forbidden by the spec.',
    )
  }

  // Empty string emits no Access-Control-Allow-Origin at all, leaving the
  // same-origin policy in force — safer than defaulting to '*'.
  const origin = options.origin ?? (() => '')

  // Unset keys are omitted, not forwarded as `undefined` — see
  // DEFAULT_ALLOW_METHODS.
  return cors({
    origin,
    allowMethods: options.allowMethods ?? DEFAULT_ALLOW_METHODS,
    ...(options.allowHeaders !== undefined && { allowHeaders: options.allowHeaders }),
    ...(options.exposeHeaders !== undefined && { exposeHeaders: options.exposeHeaders }),
    ...(options.maxAge !== undefined && { maxAge: options.maxAge }),
    ...(options.credentials !== undefined && { credentials: options.credentials }),
  })
}
