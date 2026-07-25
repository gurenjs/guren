import type { Context, MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { jsonResponse } from './index'
import { getSessionFromContext } from './session'
import { deriveAppKeyring, getAppKeyringFromEnv } from '../../encryption/app-key'

export const CSRF_TOKEN_KEY = '_csrf_token'
export const CSRF_HEADER_NAME = 'X-CSRF-TOKEN'
export const XSRF_HEADER_NAME = 'X-XSRF-TOKEN'
export const XSRF_COOKIE_NAME = 'XSRF-TOKEN'
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

  /**
   * Set the CSRF token as an `XSRF-TOKEN` cookie on every response.
   * This enables Axios/Inertia.js to automatically read the cookie
   * and send it back as the `X-XSRF-TOKEN` header.
   * Defaults to true.
   */
  cookie?: boolean

  /**
   * Cookie options when `cookie` is enabled.
   */
  cookieOptions?: {
    path?: string
    secure?: boolean
    sameSite?: 'Strict' | 'Lax' | 'None'
  }
}

const DEFAULT_PROTECTED_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE']

const DEFAULT_COOKIE_SECURE = typeof process !== 'undefined'
  ? process.env.NODE_ENV === 'production'
  : true

const CSRF_CONTEXT_KEY = 'guren:csrf-token'

function generateRandomValue(): string {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

// Signing keys derived per APP_KEY/APP_PREVIOUS_KEYS values so tests that
// swap keys mid-process get fresh keyrings while normal runs derive once.
let cachedKeys: { source: string; keys: Buffer[] } | undefined

function resolveCsrfKeys(): Buffer[] {
  const source = `${process.env.APP_KEY ?? ''}|${process.env.APP_PREVIOUS_KEYS ?? ''}`
  if (!cachedKeys || cachedKeys.source !== source) {
    const keyring = deriveAppKeyring(getAppKeyringFromEnv(), 'csrf-token')
    cachedKeys = { source, keys: [keyring.current, ...keyring.previous] }
  }
  return cachedKeys.keys
}

function signValue(value: string, key: Buffer): string {
  return createHmac('sha256', key).update(`csrf|${value}`).digest('base64url')
}

function mintCsrfToken(): string {
  const value = generateRandomValue()
  return `${value}.${signValue(value, resolveCsrfKeys()[0])}`
}

function isSignedCsrfToken(token: string): boolean {
  const [value, signature, extra] = token.split('.')
  if (!value || !signature || extra !== undefined) {
    return false
  }
  return resolveCsrfKeys().some((key) => timingSafeEqualStrings(signature, signValue(value, key)))
}

function timingSafeEqualStrings(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual, 'utf8')
  const expectedBuffer = Buffer.from(expected, 'utf8')
  if (actualBuffer.length !== expectedBuffer.length) {
    return false
  }
  return timingSafeEqual(actualBuffer, expectedBuffer)
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
 * Get the request's CSRF token.
 *
 * Stateless signed double-submit: the token lives only in the `XSRF-TOKEN`
 * cookie (`random.signature`, HMAC over the app keyring) — nothing is stored
 * server-side, so anonymous page views cost no session writes. A valid
 * cookie token is reused; otherwise a fresh token is minted and set on the
 * response by the middleware.
 */
export function getCsrfToken(ctx: Context): string {
  const pending = ctx.get(CSRF_CONTEXT_KEY) as string | undefined
  if (pending) {
    return pending
  }

  const cookieToken = getCookie(ctx, XSRF_COOKIE_NAME)
  if (cookieToken && isSignedCsrfToken(cookieToken)) {
    ctx.set(CSRF_CONTEXT_KEY, cookieToken)
    return cookieToken
  }

  const token = mintCsrfToken()
  ctx.set(CSRF_CONTEXT_KEY, token)
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
 * Verify a request token.
 *
 * Primary check (stateless): the token must carry a valid app-key signature
 * AND match the `XSRF-TOKEN` cookie — the signature proves this server
 * minted it, the cookie match binds it to this browser (a sibling-domain
 * attacker can plant cookies but cannot sign them).
 *
 * Legacy fallback: tokens stored in sessions by earlier releases keep
 * verifying against the session until those sessions expire.
 */
export function verifyCsrfToken(ctx: Context, token: string | undefined): boolean {
  if (!token) {
    return false
  }

  const cookieToken = getCookie(ctx, XSRF_COOKIE_NAME)
  if (
    cookieToken &&
    isSignedCsrfToken(token) &&
    timingSafeEqualStrings(token, cookieToken)
  ) {
    return true
  }

  const session = getSessionFromContext(ctx)
  if (!session) {
    return false
  }

  const sessionToken = session.get(CSRF_TOKEN_KEY) as string | undefined
  if (!sessionToken) {
    return false
  }

  return timingSafeEqualStrings(token, sessionToken)
}

async function getTokenFromRequest(ctx: Context): Promise<string | undefined> {
  // Check X-CSRF-TOKEN header
  const headerToken = ctx.req.header(CSRF_HEADER_NAME)
  if (headerToken) {
    return headerToken
  }

  // Check X-XSRF-TOKEN header (sent automatically by Axios from XSRF-TOKEN cookie)
  const xsrfToken = ctx.req.header(XSRF_HEADER_NAME)
  if (xsrfToken) {
    return xsrfToken
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
 * - Issues a stateless signed token in the `XSRF-TOKEN` cookie on safe
 *   requests (double-submit; nothing is stored server-side, so anonymous
 *   traffic costs no session writes and no session middleware is required)
 * - Validates the token for state-changing HTTP methods (POST, PUT, PATCH,
 *   DELETE): the request token must be app-key signed and match the cookie
 * - Supports token submission via form field (_token) or header (X-CSRF-TOKEN)
 * - Keeps verifying tokens stored in sessions by earlier releases until
 *   those sessions expire
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
    cookie: enableCookie = true,
    cookieOptions = {},
  } = options

  const protectedMethods = new Set(methods.map((m) => m.toUpperCase()))

  return async (ctx, next) => {
    const method = ctx.req.method.toUpperCase()
    const path = new URL(ctx.req.url).pathname

    // For safe methods, just ensure token exists and set cookie
    if (!protectedMethods.has(method)) {
      const token = getCsrfToken(ctx)
      await next()
      if (enableCookie) {
        setXsrfCookie(ctx, token, cookieOptions)
      }
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

    // Refresh the cookie after successful mutation
    if (enableCookie) {
      setXsrfCookie(ctx, getCsrfToken(ctx), cookieOptions)
    }
  }
}

function setXsrfCookie(
  ctx: Context,
  token: string,
  options: CsrfOptions['cookieOptions'] = {},
): void {
  const { path = '/', secure = DEFAULT_COOKIE_SECURE, sameSite = 'Lax' } = options
  // httpOnly must be false so JavaScript (Axios) can read the cookie.
  // Must append: setting Set-Cookie wholesale on the finalized response
  // wipes cookies added by inner middleware and handlers.
  ctx.header(
    'Set-Cookie',
    `${XSRF_COOKIE_NAME}=${encodeURIComponent(token)}; Path=${path}; SameSite=${sameSite}${secure ? '; Secure' : ''}`,
    { append: true },
  )
}
