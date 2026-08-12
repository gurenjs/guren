import { deleteCookie, getCookie } from 'hono/cookie'
import { serialize } from 'hono/utils/cookie'
import type { Context, MiddlewareHandler } from 'hono'

/**
 * Cookie flash for Inertia validation errors on apps with no session.
 *
 * The Laravel-style flow flashes errors to the session and redirects back,
 * but sessions are only mounted when `createApp({ auth })` is configured — a
 * fresh scaffold has none yet. Dropping the errors silently turns every
 * validation failure into "the form did nothing", so without a session the
 * flattened errors ride across the one redirect in a short-lived HttpOnly
 * cookie instead: display-only data, no store required, working on every
 * runtime (Bun, Workers, Lambda).
 */
export const VALIDATION_ERRORS_COOKIE = 'guren_validation_errors'

/**
 * Bounds how long an unconsumed flash can linger — the cleanup middleware
 * expires the cookie on the render that consumed it, so this only covers a
 * redirect the browser never followed.
 */
const COOKIE_MAX_AGE_SECONDS = 60

/**
 * Upper bound for the encoded cookie value. Browsers cap a cookie around
 * 4096 bytes and drop oversized ones *silently* — which would lose the errors
 * exactly the way the missing session used to. Fields that don't fit are
 * skipped individually, so the smaller ones that follow still make the trip;
 * some errors beat none.
 */
const MAX_COOKIE_VALUE_LENGTH = 3800

/**
 * Marks that this request's flashed errors were actually read (delivered to
 * shared props), so the cleanup middleware knows the flash is spent. Deleting
 * on mere *presence* would let any intermediate response — a trailing-slash
 * redirect, an auth bounce — burn the flash before a render ever showed it;
 * a session flash survives exactly those hops because it is consumed on read.
 */
const CONSUMED_CONTEXT_KEY = 'gurenValidationErrorsCookieConsumed'

/**
 * The `Set-Cookie` value that flashes `errors` across the next redirect.
 */
export function validationErrorsSetCookie(errors: Record<string, string>): string {
  const kept: Record<string, string> = {}

  for (const [field, message] of Object.entries(errors)) {
    const next = encodeURIComponent(JSON.stringify({ ...kept, [field]: message }))
    if (next.length > MAX_COOKIE_VALUE_LENGTH) {
      continue
    }
    kept[field] = message
  }

  // `serialize` URI-encodes the value itself, matching the length measured
  // above and the decode `getCookie` applies on the way back.
  return serialize(VALIDATION_ERRORS_COOKIE, JSON.stringify(kept), {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: COOKIE_MAX_AGE_SECONDS,
  })
}

/**
 * The flashed errors carried by the current request, if any. Reading consumes
 * the flash: the cleanup middleware expires the cookie on this response.
 */
export function readValidationErrorsCookie(ctx: Context): Record<string, string> | undefined {
  const raw = getCookie(ctx, VALIDATION_ERRORS_COOKIE)
  if (!raw) {
    return undefined
  }

  // A malformed cookie counts as consumed too — expiring it beats carrying
  // undecodable bytes around for another minute.
  ctx.set(CONSUMED_CONTEXT_KEY, true)

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined
  }

  const errors: Record<string, string> = {}
  for (const [field, message] of Object.entries(parsed)) {
    if (typeof message === 'string') {
      errors[field] = message
    }
  }

  return Object.keys(errors).length > 0 ? errors : undefined
}

/**
 * Expires the flash cookie on the response whose render consumed it,
 * restoring the show-once semantics a session flash has. Runs post-`next()`,
 * so a thrown `ValidationException` (whose renderer may be *setting* a fresh
 * cookie on its 303) never reaches the deletion — and the `getSetCookie`
 * guard covers any other path that just wrote the cookie on this same
 * response.
 */
export function createValidationErrorsCookieCleanup(): MiddlewareHandler {
  return async (ctx, next) => {
    await next()

    if (!ctx.get(CONSUMED_CONTEXT_KEY)) {
      return
    }

    const setCookies = ctx.res.headers.getSetCookie?.() ?? []
    if (setCookies.some((header) => header.startsWith(`${VALIDATION_ERRORS_COOKIE}=`))) {
      return
    }

    deleteCookie(ctx, VALIDATION_ERRORS_COOKIE, { path: '/' })
  }
}
