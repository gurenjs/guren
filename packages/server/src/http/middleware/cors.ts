import type { MiddlewareHandler } from 'hono'
import { cors } from 'hono/cors'

export interface CorsOptions {
  /**
   * Allowed origins. Default: none (same-origin policy applies).
   * - A string: exact origin match (use '*' to allow all origins)
   * - An array of strings: multiple allowed origins
   * - A function: dynamic origin evaluation
   */
  origin?: string | string[] | ((origin: string, ctx: unknown) => string | undefined | null)
  /** Allowed HTTP methods. Default: ['GET', 'HEAD', 'PUT', 'POST', 'DELETE', 'PATCH', 'QUERY'] */
  allowMethods?: string[]
  /** Allowed request headers. */
  allowHeaders?: string[]
  /** Headers exposed to the browser. */
  exposeHeaders?: string[]
  /** Preflight cache max-age in seconds. */
  maxAge?: number
  /** Allow credentials (cookies, authorization headers). Default: false */
  credentials?: boolean
}

// Guren owns the method default instead of relying on Hono's: the supported
// Hono range (^4.12.29) starts before Hono's own list gained QUERY, and Hono
// spreads caller options over its defaults, so a key passed as `undefined`
// would erase the default entirely (a preflight with no
// Access-Control-Allow-Methods at all).
const DEFAULT_ALLOW_METHODS = ['GET', 'HEAD', 'PUT', 'POST', 'DELETE', 'PATCH', 'QUERY']

/**
 * CORS middleware powered by Hono's built-in CORS support.
 *
 * @example
 * ```ts
 * import { createCorsMiddleware } from '@guren/core'
 *
 * // Allow specific origins
 * app.use('/api/*', createCorsMiddleware({
 *   origin: ['https://example.com', 'https://app.example.com'],
 *   credentials: true,
 * }))
 *
 * // Dynamic origin
 * app.use('/api/*', createCorsMiddleware({
 *   origin: (origin) => origin.endsWith('.example.com') ? origin : null,
 * }))
 * ```
 */
export function createCorsMiddleware(options: CorsOptions = {}): MiddlewareHandler {
  if (options.credentials && !options.origin) {
    throw new Error(
      'CORS: credentials requires an explicit origin. ' +
      'Wildcard origin (*) with credentials is forbidden by the spec.',
    )
  }

  // When no origin is configured, reject all cross-origin requests by
  // returning an empty string so no Access-Control-Allow-Origin header is
  // set and the browser's same-origin policy applies.
  // This is safer than defaulting to '*' which would allow any origin.
  const origin = options.origin ?? (() => '')

  // Omit unset keys rather than forwarding `undefined` — see the
  // DEFAULT_ALLOW_METHODS note for why an explicit `undefined` is not
  // equivalent to leaving a key out.
  return cors({
    origin,
    allowMethods: options.allowMethods ?? DEFAULT_ALLOW_METHODS,
    ...(options.allowHeaders !== undefined && { allowHeaders: options.allowHeaders }),
    ...(options.exposeHeaders !== undefined && { exposeHeaders: options.exposeHeaders }),
    ...(options.maxAge !== undefined && { maxAge: options.maxAge }),
    ...(options.credentials !== undefined && { credentials: options.credentials }),
  })
}
