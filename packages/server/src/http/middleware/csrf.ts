import type { Context, MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import { jsonResponse } from './index'
import { getSessionFromContext, type Session } from './session'
import { deriveAppKeyring, getAppKeyringFromEnv } from '../../encryption/app-key'
import { MessageSigner } from '../../encryption/MessageSigner'
import { secureCompare } from '../../encryption/Hash'
import { isMcpEndpointEnabled, MCP_ENDPOINT_PATH } from '../../mcp/endpoint'

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
const CSRF_PURPOSE = 'csrf'

interface CsrfClaims extends Record<string, unknown> {
  /** Present on session-bound tokens: the session id the token is tied to. */
  sid?: string
  /** Present on stateless tokens: random entropy for the double-submit value. */
  n?: string
}

// Follows the createXSigner() convention used by email-verification /
// password-reset / signed-url: derive a purpose-scoped keyring per call
// (a single HKDF derivation is cheap) and let MessageSigner own the
// sign/verify/rotation/timing-safe machinery.
function createCsrfSigner(): MessageSigner {
  return new MessageSigner(deriveAppKeyring(getAppKeyringFromEnv(), 'csrf-token'))
}

function randomNonce(): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * A session that outlives this response under its current id is bind-able.
 * An empty brand-new session is not: under the write-reduction rules it is
 * never persisted, so there is no id for a later request to match.
 *
 * `!isNew` is not the test. A session created during *this* request stays
 * `isNew` for its whole lifetime, so a login response would mint a guest
 * (stateless) token even though the session it just wrote is what the next
 * request authenticates with — and that token would then be rejected by
 * `verifyCsrfToken`'s mode rule. `willPersist()` answers the actual
 * question; the `!isNew` fallback keeps custom `Session` implementations
 * that predate it working as before.
 */
function bindableSessionId(session: Session | undefined): string | undefined {
  if (!session) {
    return undefined
  }

  const persists = session.willPersist ? session.willPersist() : !session.isNew
  return persists ? session.id : undefined
}

/**
 * Session-bound when a stable session exists (immune to sibling-subdomain
 * cookie injection — verification checks the live session id, which an
 * attacker cannot forge), otherwise a stateless random token (double-submit)
 * for guests, who carry no authenticated state to protect.
 */
function mintCsrfToken(sessionId: string | undefined): string {
  const signer = createCsrfSigner()
  return sessionId
    ? signer.sign({ sid: sessionId }, { purpose: CSRF_PURPOSE })
    : signer.sign({ n: randomNonce() }, { purpose: CSRF_PURPOSE })
}

function verifiedClaims(token: string): CsrfClaims | null {
  return createCsrfSigner().verify<CsrfClaims>(token, { purpose: CSRF_PURPOSE })
}

/**
 * A cookie token is reusable only in the mode it was minted for: a bound
 * token only for its own session, a stateless token only while there is
 * still no session to bind to.
 */
function claimsUsableFor(claims: CsrfClaims, boundId: string | undefined): boolean {
  return claims.sid !== undefined ? claims.sid === boundId : boundId === undefined
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
 * The MCP endpoint is exempt wherever CSRF is mounted.
 *
 * MCP clients (Claude Code, Cursor) POST JSON-RPC directly and never make a
 * preceding GET to pick up an `XSRF-TOKEN`, so CSRF would make the endpoint
 * unreachable for every client Guren ships config for. Nothing is exempted
 * in production or without `GUREN_MCP=1`, because the route does not exist
 * there; the endpoint enforces its own local-only access guard instead.
 */
function isMcpEndpointRequest(path: string): boolean {
  return path === MCP_ENDPOINT_PATH && isMcpEndpointEnabled()
}

/**
 * Get the request's CSRF token.
 *
 * Signed token bound to the session when a stable one exists, otherwise a
 * stateless signed double-submit token for guests. Nothing is stored
 * server-side, so anonymous page views cost no session writes. A cookie
 * token that is still valid for this request's mode is reused; otherwise a
 * fresh token is minted and set on the response by the middleware.
 */
export function getCsrfToken(ctx: Context): string {
  const pending = ctx.get(CSRF_CONTEXT_KEY) as string | undefined
  if (pending) {
    return pending
  }

  return issueCsrfToken(ctx)
}

/**
 * Mint (or reuse the cookie's token) against the session state as it stands
 * right now, caching the result on the context.
 */
function issueCsrfToken(ctx: Context): string {
  const boundId = bindableSessionId(getSessionFromContext(ctx))

  const cookieToken = getCookie(ctx, XSRF_COOKIE_NAME)
  if (cookieToken) {
    const claims = verifiedClaims(cookieToken)
    if (claims && claimsUsableFor(claims, boundId)) {
      ctx.set(CSRF_CONTEXT_KEY, cookieToken)
      return cookieToken
    }
  }

  const token = mintCsrfToken(boundId)
  ctx.set(CSRF_CONTEXT_KEY, token)
  return token
}

/**
 * The token to write to the response cookie, re-checked against the session
 * as the handler left it.
 *
 * A token chosen before the handler ran can be the wrong mode by the time
 * the response is written — a login turns a guest request into a session-
 * bearing one — and a stale stateless token would be rejected on the next
 * mutation now that verification enforces the mode rule.
 */
function refreshCsrfToken(ctx: Context): string {
  const pending = ctx.get(CSRF_CONTEXT_KEY) as string | undefined
  if (pending) {
    const boundId = bindableSessionId(getSessionFromContext(ctx))
    const claims = verifiedClaims(pending)
    if (claims && claimsUsableFor(claims, boundId)) {
      return pending
    }
  }

  ctx.set(CSRF_CONTEXT_KEY, undefined)
  return issueCsrfToken(ctx)
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
 * The token must first carry a valid app-key signature (proving this server
 * minted it). The mode is then fixed by the request — whether it carries a
 * bindable session — and the token has to be in that mode:
 * - **Session-bound** (request has a session; token must carry a matching
 *   `sid`): immune to cookie injection — a sibling-subdomain attacker can
 *   plant a cookie but cannot know the victim's session id. A stateless
 *   token is rejected here, which is the point: anyone can mint one.
 * - **Stateless** (request has no session, so no `sid`): the token must match the `XSRF-TOKEN`
 *   cookie (double-submit). Guests hold no authenticated state to protect.
 *
 * Legacy fallback: tokens stored in sessions by earlier releases keep
 * verifying against the session until those sessions expire. Remove this
 * branch once all pre-upgrade sessions have aged out (a major release).
 */
export function verifyCsrfToken(ctx: Context, token: string | undefined): boolean {
  if (!token) {
    return false
  }

  const claims = verifiedClaims(token)
  if (claims) {
    // The mode is chosen by the *request*, not by the token: a request that
    // carries a bindable session must clear the session-bound check, and a
    // stateless token is only ever accepted where there is no session to
    // bind to. Reading the mode off the token instead would let a guest
    // token — which anyone can mint by visiting the site — authorize a
    // mutation for a logged-in user, so long as it matched the `XSRF-TOKEN`
    // cookie, and that cookie is writable by any sibling subdomain.
    const boundId = bindableSessionId(getSessionFromContext(ctx))

    if (claims.sid !== undefined) {
      if (boundId !== undefined && secureCompare(claims.sid, boundId)) {
        return true
      }
    } else if (boundId === undefined) {
      const cookieToken = getCookie(ctx, XSRF_COOKIE_NAME)
      if (cookieToken && secureCompare(token, cookieToken)) {
        return true
      }
    }
  }

  const sessionToken = getSessionFromContext(ctx)?.get(CSRF_TOKEN_KEY) as string | undefined
  return sessionToken !== undefined && secureCompare(token, sessionToken)
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
 * - Issues a signed token in the `XSRF-TOKEN` cookie on safe requests.
 *   With a logged-in session the token is bound to the session id; for
 *   guests it is a stateless double-submit token. Nothing is stored
 *   server-side, so anonymous traffic costs no session writes and session
 *   middleware is optional.
 * - Validates the token for state-changing HTTP methods (POST, PUT, PATCH,
 *   DELETE): always requires a valid app-key signature, then the bound
 *   session id or (guest) the cookie match.
 * - Supports token submission via form field (_token) or header (X-CSRF-TOKEN)
 * - Keeps verifying tokens stored in sessions by earlier releases until
 *   those sessions expire
 * - Exempts the dev-only MCP endpoint while it is mounted, since agent
 *   clients cannot fetch a token first (it guards local-only access instead)
 *
 * `cookie: false` disables the `XSRF-TOKEN` cookie for apps that deliver the
 * token themselves (meta tag / form field). Session-bound tokens still
 * verify without the cookie; guest (stateless) tokens require the cookie, so
 * disable it only for session-authenticated flows.
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

    // For safe methods, just ensure a token is available to the handler and
    // set the cookie. The cookie value is settled *after* the handler, since
    // a handler that establishes a session changes which mode the token has
    // to be in.
    if (!protectedMethods.has(method)) {
      getCsrfToken(ctx)
      await next()
      if (enableCookie) {
        setXsrfCookie(ctx, refreshCsrfToken(ctx), cookieOptions)
      }
      return
    }

    // Check if path is excluded
    if (isExcluded(path, exclude) || isMcpEndpointRequest(path)) {
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

    // Refresh the cookie after successful mutation. A login POST lands here
    // having verified a guest token, and must leave with a session-bound one.
    if (enableCookie) {
      setXsrfCookie(ctx, refreshCsrfToken(ctx), cookieOptions)
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
