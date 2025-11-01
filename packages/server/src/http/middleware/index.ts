import type { MiddlewareHandler } from 'hono'

export type Middleware = MiddlewareHandler

export function defineMiddleware(handler: MiddlewareHandler): MiddlewareHandler {
  return handler
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
