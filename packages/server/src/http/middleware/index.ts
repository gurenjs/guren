import type { MiddlewareHandler } from 'hono'

export type Middleware = MiddlewareHandler

export function defineMiddleware(handler: MiddlewareHandler): MiddlewareHandler {
  return handler
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

export { createSessionMiddleware, MemorySessionStore, getSessionFromContext } from './session'
export type { Session, SessionData, SessionStore } from './session'
export {
  requireAuthenticated,
  requireGuest,
  attachAuthContext,
  type AuthContext,
  type RequireAuthOptions,
} from './auth'
export {
  createCsrfMiddleware,
  getCsrfToken,
  csrfField,
  verifyCsrfToken,
  CSRF_TOKEN_KEY,
  CSRF_HEADER_NAME,
  CSRF_FORM_FIELD,
  XSRF_HEADER_NAME,
  XSRF_COOKIE_NAME,
  type CsrfOptions,
} from './csrf'
export {
  validateRequest,
  validateRequestWith,
  getValidatedData,
  validate,
  validateSafe,
  VALIDATED_DATA_KEY,
  type ValidationSchema,
  type ValidateRequestOptions,
} from './validation'
export {
  createRateLimitMiddleware,
  getRateLimitInfo,
  resetRateLimit,
  MemoryRateLimitStore,
  SlidingWindowRateLimitStore,
  type RateLimitOptions,
  type RateLimitStore,
  type RateLimitEntry,
  type RateLimitInfo,
} from './rate-limit'
