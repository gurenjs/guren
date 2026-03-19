import type { Context, MiddlewareHandler } from 'hono'
import { jsonResponse } from './index'
import { getSessionFromContext } from './session'

export const CSRF_TOKEN_KEY = '_csrf_token'
export const CSRF_HEADER_NAME = 'X-CSRF-TOKEN'
export const CSRF_FORM_FIELD = '_token'

export interface CsrfOptions {
  /**
   * Routes to exclude from CSRF protection.
   * Supports exact paths ('/api/webhook') or patterns ('/api/*').
   */
  exclude?: string[]

  /**
   * Custom error handler when CSRF validation fails.
   * Defaults to returning a 403 JSON response.
   */
  onError?: (ctx: Context) => Response | Promise<Response>

  /**
   * HTTP methods that require CSRF token validation.
   * Defaults to ['POST', 'PUT', 'PATCH', 'DELETE'].
   */
  methods?: string[]
}

const DEFAULT_PROTECTED_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE']

function generateToken(): string {
  return globalThis.crypto.randomUUID()
}

function matchesPattern(path: string, pattern: string): boolean {
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -2)
    return path === prefix || path.startsWith(prefix + '/')
  }
  return path === pattern
}

function isExcluded(path: string, excludePatterns: string[]): boolean {
  return excludePatterns.some((pattern) => matchesPattern(path, pattern))
}

/**
 * Get the CSRF token from the current session.
 * Creates a new token if one doesn't exist.
 */
export function getCsrfToken(ctx: Context): string {
  const session = getSessionFromContext(ctx)

  if (!session) {
    throw new Error('CSRF middleware requires session middleware to be registered first.')
  }

  let token = session.get(CSRF_TOKEN_KEY) as string | undefined

  if (!token) {
    token = generateToken()
    session.set(CSRF_TOKEN_KEY, token)
  }

  return token
}

/**
 * Generate an HTML hidden input field containing the CSRF token.
 */
export function csrfField(ctx: Context): string {
  const token = getCsrfToken(ctx)
  return `<input type="hidden" name="${CSRF_FORM_FIELD}" value="${token}" />`
}

/**
 * Verify that the provided token matches the session's CSRF token.
 */
export function verifyCsrfToken(ctx: Context, token: string | undefined): boolean {
  if (!token) {
    return false
  }

  const session = getSessionFromContext(ctx)
  if (!session) {
    return false
  }

  const sessionToken = session.get(CSRF_TOKEN_KEY) as string | undefined
  if (!sessionToken) {
    return false
  }

  // Timing-safe comparison
  if (token.length !== sessionToken.length) {
    return false
  }

  let result = 0
  for (let i = 0; i < token.length; i++) {
    result |= token.charCodeAt(i) ^ sessionToken.charCodeAt(i)
  }

  return result === 0
}

async function getTokenFromRequest(ctx: Context): Promise<string | undefined> {
  // First, check header
  const headerToken = ctx.req.header(CSRF_HEADER_NAME)
  if (headerToken) {
    return headerToken
  }

  // Then, check form body
  const contentType = ctx.req.header('content-type') ?? ''

  if (
    contentType.includes('application/x-www-form-urlencoded') ||
    contentType.includes('multipart/form-data')
  ) {
    try {
      const body = await ctx.req.parseBody()
      const formToken = body[CSRF_FORM_FIELD]
      if (typeof formToken === 'string') {
        return formToken
      }
    } catch {
      // Ignore parse errors
    }
  }

  // Check JSON body
  if (contentType.includes('application/json')) {
    try {
      const json = await ctx.req.json()
      if (json && typeof json === 'object' && CSRF_FORM_FIELD in json) {
        const jsonToken = (json as Record<string, unknown>)[CSRF_FORM_FIELD]
        if (typeof jsonToken === 'string') {
          return jsonToken
        }
      }
    } catch {
      // Ignore parse errors
    }
  }

  return undefined
}

/**
 * Creates a CSRF protection middleware.
 *
 * This middleware:
 * - Generates and stores a CSRF token in the session for GET requests
 * - Validates the CSRF token for state-changing HTTP methods (POST, PUT, PATCH, DELETE)
 * - Supports token submission via form field (_token) or header (X-CSRF-TOKEN)
 *
 * @example
 * ```ts
 * import { createCsrfMiddleware } from '@guren/server'
 *
 * app.use(createSessionMiddleware())
 * app.use(createCsrfMiddleware({
 *   exclude: ['/api/webhooks/*']
 * }))
 * ```
 */
export function createCsrfMiddleware(options: CsrfOptions = {}): MiddlewareHandler {
  const {
    exclude = [],
    onError,
    methods = DEFAULT_PROTECTED_METHODS,
  } = options

  const protectedMethods = new Set(methods.map((m) => m.toUpperCase()))

  return async (ctx, next) => {
    const session = getSessionFromContext(ctx)

    if (!session) {
      throw new Error('CSRF middleware requires session middleware to be registered first.')
    }

    const method = ctx.req.method.toUpperCase()
    const path = new URL(ctx.req.url).pathname

    // For safe methods, just ensure token exists
    if (!protectedMethods.has(method)) {
      // Ensure a token exists in the session for later use
      getCsrfToken(ctx)
      await next()
      return
    }

    // Check if path is excluded
    if (isExcluded(path, exclude)) {
      await next()
      return
    }

    // Validate CSRF token for protected methods
    const requestToken = await getTokenFromRequest(ctx)
    const isValid = verifyCsrfToken(ctx, requestToken)

    if (!isValid) {
      if (onError) {
        return onError(ctx)
      }

      return jsonResponse({ message: 'CSRF token mismatch' }, 403)
    }

    await next()
  }
}
