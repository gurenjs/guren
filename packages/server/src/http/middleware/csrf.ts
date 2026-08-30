import type { Context, MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import { jsonResponse } from './index'
import { getSessionFromContext, type Session } from './session'
import { deriveAppKeyring, getAppKeyringFromEnv } from '../../encryption/app-key'
import { MessageSigner } from '../../encryption/MessageSigner'
import { secureCompare } from '../../encryption/Hash'
import { isMcpEndpointEnabled, MCP_ENDPOINT_PATH } from '../../mcp/endpoint'
import { hasBearerHeader } from '../../auth/api-token'

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
 * The session id a token may anchor to, or undefined for a guest request.
 *
 * `Session.willPersist()` is the question being asked — see its definition
 * for why `!isNew` is the wrong predicate. A custom `Session` that predates
 * the method falls back to `!isNew`, which reproduces the pre-fix behaviour
 * for that implementation: its login response mints a guest token that the
 * next request then rejects. Implement `willPersist()` to avoid that.
 */
function bindableSessionId(session: Session | undefined): string | undefined {
  if (!session) {
    return undefined
  }

  return (session.willPersist?.() ?? !session.isNew) ? session.id : undefined
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
 * The one statement of the mode rule, shared by issuing and verification: a
 * bound token is usable only for its own session, a stateless token only
 * while there is no session to bind to. Both callers must agree — a mint
 * that outruns verification locks users out, and a verification looser than
 * minting is a CSRF bypass.
 */
function claimsUsableFor(claims: CsrfClaims, boundId: string | undefined): boolean {
  if (claims.sid === undefined) {
    return boundId === undefined
  }

  return boundId !== undefined && secureCompare(claims.sid, boundId)
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
 * A bearer-authenticated request that carries no cookies at all (RFC 0016
 * §3). CSRF defends cookie ambient authority — a browser attaching the
 * victim's cookies to a request the victim never made. A request that
 * authenticates by `Authorization: Bearer` and sends no `Cookie` header has
 * none to attach: the token is the client's own credential, deliberately
 * presented, and a browser cannot strip its cookies from a cross-site
 * request. Agent tool dispatch is the intended caller — it synthesizes
 * cookie-less bearer requests by construction.
 *
 * The predicate is the raw `Cookie` header, deliberately not the loaded
 * session. Ambient authority *requires a cookie*, so the header's absence is
 * proof by itself — independent of where this middleware sits relative to
 * the session mount. A session-based predicate reads as more precise and is
 * weaker on both edges: mounted before the session middleware it sees no
 * session and fails open for a cookie-carrying victim browser, and an
 * intermediate middleware that writes one value into a fresh session turns a
 * genuinely cookie-less client into a 403. Any cookie — even one this app
 * never reads — therefore keeps verification on; a bearer client that wants
 * the skip sends none, which is what every non-browser client does.
 *
 * Bearer detection is `hasBearerHeader`, the same predicate
 * `AuthManager.resolveGuardName` routes a request to the token guard by, so
 * this rule and token authentication cannot disagree about what a bearer
 * request is.
 */
function isBearerRequestWithoutCookies(ctx: Context): boolean {
  if (!hasBearerHeader(ctx)) {
    return false
  }

  // Only true absence skips: an empty `Cookie:` header is malformed enough
  // to stay on the verifying path.
  return ctx.req.header('Cookie') === undefined
}

/** The token issued so far this request, and the mode it was issued for. */
interface IssuedCsrfToken {
  token: string
  boundId: string | undefined
}

/**
 * Get the request's CSRF token.
 *
 * Signed token bound to the session when a stable one exists, otherwise a
 * stateless signed double-submit token for guests. Nothing is stored
 * server-side, so anonymous page views cost no session writes. A cookie
 * token that is still valid for this request's mode is reused; otherwise a
 * fresh token is minted and set on the response by the middleware.
 *
 * The answer tracks the session as it stands *at the moment of the call*,
 * because a handler can change it: log a user in and the correct token stops
 * being the guest one it would have got a line earlier. A token cached from
 * before that point would be rendered into the response body while the
 * response cookie carried a session-bound one, and `verifyCsrfToken` would
 * then reject the form on submit. So the per-request cache is keyed by the
 * mode it was issued for, and re-issues when the mode moves — which also
 * makes re-reads free, since the common case is that nothing changed.
 */
export function getCsrfToken(ctx: Context): string {
  const boundId = bindableSessionId(getSessionFromContext(ctx))

  const issued = ctx.get(CSRF_CONTEXT_KEY) as IssuedCsrfToken | undefined
  if (issued && issued.boundId === boundId) {
    return issued.token
  }

  return remember(ctx, reusableCookieToken(ctx, boundId) ?? mintCsrfToken(boundId), boundId)
}

/** The request's `XSRF-TOKEN`, if it is valid for this mode. */
function reusableCookieToken(ctx: Context, boundId: string | undefined): string | undefined {
  const cookieToken = getCookie(ctx, XSRF_COOKIE_NAME)
  if (!cookieToken) {
    return undefined
  }

  const claims = verifiedClaims(cookieToken)
  return claims && claimsUsableFor(claims, boundId) ? cookieToken : undefined
}

function remember(ctx: Context, token: string, boundId: string | undefined): string {
  ctx.set(CSRF_CONTEXT_KEY, { token, boundId } satisfies IssuedCsrfToken)
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
  if (claims && claimsUsableFor(claims, bindableSessionId(getSessionFromContext(ctx)))) {
    // A bound token is already proven by the session match `claimsUsableFor`
    // just made. A stateless one proves only that this server minted it —
    // anyone can get one by visiting the site — so it still has to match the
    // cookie.
    if (claims.sid !== undefined) {
      return true
    }

    const cookieToken = getCookie(ctx, XSRF_COOKIE_NAME)
    if (cookieToken && secureCompare(token, cookieToken)) {
      return true
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
 * - Skips verification for `Authorization: Bearer` requests that carry no
 *   cookies (RFC 0016) — token clients authenticate per request and hold no
 *   cookie ambient authority for CSRF to defend
 *
 * `cookie: false` disables the `XSRF-TOKEN` cookie for apps that deliver the
 * token themselves (meta tag / form field). Session-bound tokens still
 * verify without the cookie; guest (stateless) tokens require the cookie, so
 * disable it only for session-authenticated flows.
 *
 * **Mount it directly inside the session middleware.** The response cookie is
 * settled once the handler returns, reading the session id as it stands then.
 * Middleware layered *between* the two that mutates the session after its own
 * `await next()` — regenerating or invalidating it — moves the id after this
 * has already committed to a token, and the next mutation is rejected. The
 * automatic registration in `AuthServiceProvider` mounts them adjacently;
 * hand-composed chains have to keep that property.
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

  // Always settled after the handler: a request that establishes a session
  // has to leave with a token bound to it, or the next mutation is rejected.
  // Handlers reach the same value through getCsrfToken(), which re-issues on
  // the same rule, so the body and the cookie cannot disagree.
  const settleCookie = (ctx: Context): void => {
    if (enableCookie) {
      setXsrfCookie(ctx, getCsrfToken(ctx), cookieOptions)
    }
  }

  return async (ctx, next) => {
    const method = ctx.req.method.toUpperCase()
    const path = new URL(ctx.req.url).pathname

    if (!protectedMethods.has(method)) {
      await next()
      settleCookie(ctx)
      return
    }

    // Excluded and MCP paths skip *verification*, not issuance: an exempt
    // endpoint that logs a user in (an OAuth callback is the usual one) still
    // has to hand back a bound token, or every later mutation is rejected.
    // Cookie-less bearer requests skip on the same terms — see
    // isBearerRequestWithoutCookies for why that is sound.
    if (isExcluded(path, exclude) || isMcpEndpointRequest(path) || isBearerRequestWithoutCookies(ctx)) {
      await next()
      settleCookie(ctx)
      return
    }

    const requestToken = await getTokenFromRequest(ctx)
    const isValid = verifyCsrfToken(ctx, requestToken)

    if (!isValid) {
      if (onError) {
        return onError(ctx)
      }

      return jsonResponse({ message: 'CSRF token mismatch' }, 403)
    }

    await next()
    settleCookie(ctx)
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
