import { deleteCookie, getCookie } from 'hono/cookie'
import { serialize } from 'hono/utils/cookie'
import type { Context, MiddlewareHandler } from 'hono'

/**
 * Cookie flash for Inertia validation errors on apps with no session (sessions
 * are only mounted by `createApp({ auth })`, so a fresh scaffold has none).
 * Display-only data riding one redirect: no store, every runtime.
 */
export const VALIDATION_ERRORS_COOKIE = 'guren_validation_errors'

/**
 * Only bounds a redirect the browser never followed; the cleanup middleware
 * expires the cookie on the render that consumed it.
 */
const COOKIE_MAX_AGE_SECONDS = 60

/**
 * Browsers cap a cookie around 4096 bytes and drop oversized ones *silently*.
 * Fields that don't fit are skipped individually so the smaller ones still
 * make the trip.
 */
const MAX_COOKIE_VALUE_LENGTH = 3800

/**
 * Marks the flashed errors as actually read (delivered to shared props).
 * Deleting on mere *presence* would let an intermediate response — a
 * trailing-slash redirect, an auth bounce — burn the flash before a render.
 */
const CONSUMED_CONTEXT_KEY = 'gurenValidationErrorsCookieConsumed'

/** The `Set-Cookie` value that flashes `errors` across the next redirect. */
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
 * Expires the flash cookie on the response whose render consumed it, restoring
 * show-once semantics. The `getSetCookie` guard keeps it from deleting a fresh
 * cookie another path wrote on this same response.
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
