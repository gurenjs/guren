import type { Context, MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import { jsonResponse } from './index'
import { getSessionFromContext, type Session } from './session'
import { deriveAppKeyring, getAppKeyringFromEnv } from '../../encryption/app-key'
import { MessageSigner } from '../../encryption/MessageSigner'
import { secureCompare } from '../../encryption/Hash'
import { isMcpEndpointEnabled, MCP_ENDPOINT_PATH } from '../../mcp/endpoint'
import { hasBearerHeader } from '../../auth/api-token'
import { readAgentPrincipal } from '../../internal/agent-principal'

export const CSRF_TOKEN_KEY = '_csrf_token'
export const CSRF_HEADER_NAME = 'X-CSRF-TOKEN'
export const XSRF_HEADER_NAME = 'X-XSRF-TOKEN'
export const XSRF_COOKIE_NAME = 'XSRF-TOKEN'
export const CSRF_FORM_FIELD = '_token'

export interface CsrfOptions {
  /** Exact paths ('/api/webhook') or patterns ('/api/*'). */
  exclude?: string[]

  /** Defaults to a 403 JSON response. */
  onError?: (ctx: Context) => Response | Promise<Response>

  /** Defaults to ['POST', 'PUT', 'PATCH', 'DELETE']. */
  methods?: string[]

  /**
   * Set the token as an `XSRF-TOKEN` cookie, which Axios/Inertia read back into
   * the `X-XSRF-TOKEN` header. Defaults to true.
   */
  cookie?: boolean

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

// Same shape as the other createXSigner()s: a purpose-scoped keyring derived
// per call (one HKDF derivation is cheap), MessageSigner owns the rest.
function createCsrfSigner(): MessageSigner {
  return new MessageSigner(deriveAppKeyring(getAppKeyringFromEnv(), 'csrf-token'))
}

function randomNonce(): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * The session id a token may anchor to, or undefined for a guest request. A
 * custom `Session` without `willPersist()` falls back to `!isNew`, whose login
 * response mints a guest token the next request rejects — implement it.
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
 * bound token is usable only for its own session, a stateless one only while
 * there is no session to bind to. A mint that outruns verification locks users
 * out; a verification looser than minting is a CSRF bypass.
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
 * MCP clients POST JSON-RPC without a preceding GET, so they never pick up an
 * `XSRF-TOKEN`. Nothing is exempted in production or without `GUREN_MCP=1` —
 * the route does not exist there, and the endpoint guards local-only access.
 */
function isMcpEndpointRequest(path: string): boolean {
  return path === MCP_ENDPOINT_PATH && isMcpEndpointEnabled()
}

/**
 * Read per request, not snapshotted: this middleware is created in
 * `AuthServiceProvider.register()`, while an endpoint that declares itself
 * mounts at `boot`. A separate argument, not a {@link CsrfOptions} field: an
 * app fills those in, and there this would be a second `exclude` carrying none
 * of the review a declaring endpoint's own code is what supplies.
 */
export type CookielessAuthEndpoints = () => ReadonlySet<string>

/**
 * An endpoint that cannot authenticate from a session cookie has no ambient
 * authority for CSRF to defend, and verifying there only masks its own 401.
 * Exact path, never {@link matchesPattern}: a declaring endpoint mounts one
 * literal route, and a pattern here would be an escape hatch.
 */
function isCookielessAuthEndpoint(
  path: string,
  declared: CookielessAuthEndpoints | undefined,
): boolean {
  return declared !== undefined && declared().has(path)
}

/**
 * A bearer request carrying no cookies at all (RFC 0016 §3). CSRF defends
 * cookie ambient authority, so the raw `Cookie` header's absence is proof
 * wherever this sits relative to the session mount; a session-based predicate
 * fails open before it and 403s a cookie-less client after an intermediate
 * write. Bearer detection is `hasBearerHeader`, shared with `AuthManager.resolveGuardName`.
 */
function isBearerRequestWithoutCookies(ctx: Context): boolean {
  if (!hasBearerHeader(ctx)) {
    return false
  }

  // Only true absence skips: an empty `Cookie:` header is malformed enough
  // to stay on the verifying path.
  return ctx.req.header('Cookie') === undefined
}

/**
 * A request the pipeline installed an agent principal on (RFC 0017 §2), exempt
 * on the cookie-less bearer terms above: it carries no cookies **by
 * construction** and authenticates by an identity keyed on the object itself,
 * which no browser or network caller can attach to a request it did not build.
 * Verification-only, like every exemption here; issuance is unchanged.
 */
function isSeamPrincipalRequest(ctx: Context): boolean {
  return readAgentPrincipal(ctx.req.raw) !== undefined
}

/** The token issued so far this request, and the mode it was issued for. */
interface IssuedCsrfToken {
  token: string
  boundId: string | undefined
}

/**
 * The request's CSRF token: bound to the session when a stable one exists,
 * otherwise a stateless signed double-submit token. Nothing is stored
 * server-side. The per-request cache is keyed by the *mode* it was issued for,
 * because a handler can log a user in mid-request — a token cached from before
 * that would be rendered into the body while the cookie carried a bound one.
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

export function csrfField(ctx: Context): string {
  const token = getCsrfToken(ctx)
  return `<input type="hidden" name="${CSRF_FORM_FIELD}" value="${token}" />`
}

/**
 * The token must carry a valid app-key signature, and be in the mode the
 * *request* fixes: session-bound needs a matching `sid` (a sibling-subdomain
 * attacker can plant a cookie but cannot know the session id; a stateless
 * token, which anyone can mint, is rejected); stateless must match the
 * `XSRF-TOKEN` cookie. TODO: drop the legacy session-stored fallback in a major release.
 */
export function verifyCsrfToken(ctx: Context, token: string | undefined): boolean {
  if (!token) {
    return false
  }

  const claims = verifiedClaims(token)
  if (claims && claimsUsableFor(claims, bindableSessionId(getSessionFromContext(ctx)))) {
    // A bound token is proven by the session match above. A stateless one only
    // proves this server minted it, so it must still match the cookie.
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
  const headerToken = ctx.req.header(CSRF_HEADER_NAME)
  if (headerToken) {
    return headerToken
  }

  // Sent automatically by Axios from the XSRF-TOKEN cookie.
  const xsrfToken = ctx.req.header(XSRF_HEADER_NAME)
  if (xsrfToken) {
    return xsrfToken
  }

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
 * Issues a signed `XSRF-TOKEN` on safe requests and verifies it on state-changing
 * ones (`_token`, `X-CSRF-TOKEN` / `X-XSRF-TOKEN`), skipping cookie-less bearer
 * requests (RFC 0016) and seam-marked ones (RFC 0017). `cookie: false` suits
 * session flows only. **Mount directly inside the session middleware:** anything
 * between that mutates the session after `await next()` moves the id too late.
 */
export function createCsrfMiddleware(
  options: CsrfOptions = {},
  cookielessAuthEndpoints?: CookielessAuthEndpoints,
): MiddlewareHandler {
  const {
    exclude = [],
    onError,
    methods = DEFAULT_PROTECTED_METHODS,
    cookie: enableCookie = true,
    cookieOptions = {},
  } = options

  const protectedMethods = new Set(methods.map((m) => m.toUpperCase()))

  // Settled after the handler: a request that establishes a session must leave
  // with a token bound to it, or the next mutation is rejected.
  const settleCookie = (ctx: Context): void => {
    if (enableCookie) {
      setXsrfCookie(ctx, getCsrfToken(ctx), cookieOptions)
    }
  }

  return async (ctx, next) => {
    // The seam's no-cookie invariant, *asserted* above every branch below: one
    // holding only for POST is not an invariant. A seam-marked request carrying
    // a `Cookie` falsifies the exemption's premise, so it is refused rather than
    // verified — verification could pass, and passing must not be available.
    // Not through `onError`, which renders a mismatch and could be permissive.
    if (isSeamPrincipalRequest(ctx) && ctx.req.header('Cookie') !== undefined) {
      return jsonResponse(
        {
          message:
            'A request carrying an installed agent principal must not carry cookies. Refused.',
        },
        403,
      )
    }

    const method = ctx.req.method.toUpperCase()
    const path = new URL(ctx.req.url).pathname

    if (!protectedMethods.has(method)) {
      await next()
      settleCookie(ctx)
      return
    }

    // Skips *verification*, not issuance: an exempt endpoint that logs a user
    // in still has to hand back a bound token. Seam-marked requests skip on the
    // cookie-less bearer terms, their no-cookie invariant asserted above.
    if (
      isExcluded(path, exclude)
      || isMcpEndpointRequest(path)
      || isCookielessAuthEndpoint(path, cookielessAuthEndpoints)
      || isBearerRequestWithoutCookies(ctx)
      || isSeamPrincipalRequest(ctx)
    ) {
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
