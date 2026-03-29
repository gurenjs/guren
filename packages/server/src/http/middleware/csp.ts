import type { Context, MiddlewareHandler } from 'hono'

export interface CspDirectives {
  defaultSrc?: string[]
  scriptSrc?: string[]
  styleSrc?: string[]
  imgSrc?: string[]
  fontSrc?: string[]
  connectSrc?: string[]
  mediaSrc?: string[]
  objectSrc?: string[]
  frameSrc?: string[]
  childSrc?: string[]
  workerSrc?: string[]
  frameAncestors?: string[]
  formAction?: string[]
  baseUri?: string[]
  manifestSrc?: string[]
  upgradeInsecureRequests?: boolean
  blockAllMixedContent?: boolean
  /** Escape hatch for directives not listed above. */
  [directive: string]: string[] | boolean | undefined
}

export interface CspOptions {
  /** CSP directives configuration. */
  directives?: CspDirectives
  /** Use Content-Security-Policy-Report-Only instead. Default: false */
  reportOnly?: boolean
  /** URI for CSP violation reports. */
  reportUri?: string
  /** Generate a per-request nonce and auto-append to script-src and style-src. Default: false */
  useNonce?: boolean
}

export const CSP_NONCE_KEY = 'csp-nonce'

/**
 * Retrieve the CSP nonce for the current request.
 * Only available when `useNonce: true` is set.
 */
export function getCspNonce(ctx: Context): string {
  const nonce = ctx.get(CSP_NONCE_KEY as never) as string | undefined
  if (!nonce) {
    throw new Error('CSP nonce not available. Enable useNonce in createCspMiddleware options.')
  }
  return nonce
}

/**
 * Middleware that sets Content-Security-Policy headers.
 *
 * @example
 * ```ts
 * import { createCspMiddleware, getCspNonce } from '@guren/core'
 *
 * app.use('*', createCspMiddleware({
 *   directives: {
 *     defaultSrc: ["'self'"],
 *     scriptSrc: ["'self'", 'https://cdn.example.com'],
 *     styleSrc: ["'self'", "'unsafe-inline'"],
 *     imgSrc: ["'self'", 'data:', 'https:'],
 *     objectSrc: ["'none'"],
 *   },
 *   useNonce: true,
 *   reportUri: '/csp-report',
 * }))
 * ```
 */
export function createCspMiddleware(options: CspOptions = {}): MiddlewareHandler {
  const {
    directives = {},
    reportOnly = false,
    reportUri,
    useNonce = false,
  } = options

  const headerName = reportOnly
    ? 'Content-Security-Policy-Report-Only'
    : 'Content-Security-Policy'

  return async (ctx, next) => {
    const nonce = useNonce ? globalThis.crypto.randomUUID() : null

    if (nonce) {
      ctx.set(CSP_NONCE_KEY as never, nonce as never)
    }

    const headerValue = buildCspHeader(directives, nonce, reportUri)

    if (headerValue) {
      ctx.header(headerName, headerValue)
    }

    await next()
  }
}

function camelToKebab(str: string): string {
  return str.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`)
}

function buildCspHeader(
  directives: CspDirectives,
  nonce: string | null,
  reportUri?: string,
): string {
  const parts: string[] = []

  for (const [key, value] of Object.entries(directives)) {
    if (value === undefined) continue

    const directiveName = camelToKebab(key)

    // Boolean directives (e.g., upgrade-insecure-requests)
    if (typeof value === 'boolean') {
      if (value) {
        parts.push(directiveName)
      }
      continue
    }

    // Array directives
    const sources = [...value]

    // Auto-append nonce to script-src and style-src
    if (nonce && (key === 'scriptSrc' || key === 'styleSrc')) {
      sources.push(`'nonce-${nonce}'`)
    }

    parts.push(`${directiveName} ${sources.join(' ')}`)
  }

  if (reportUri) {
    parts.push(`report-uri ${reportUri}`)
  }

  return parts.join('; ')
}
