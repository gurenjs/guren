import type { Context, MiddlewareHandler } from 'hono'
import type { Authenticatable, AuthContext } from '../../auth/types'
import { jsonResponse } from './index'
import { stampCapabilities } from './capabilities'
export type { AuthContext } from '../../auth/types'

export interface RequireAuthOptions {
  redirectTo?: string
  status?: number
  responseFactory?: () => Response
}

const AUTH_CONTEXT_KEY = 'guren:auth'
const TESTING_USER_HEADER = 'x-testing-user'

function resolveTestingUser(ctx: Context): Authenticatable | null {
  // Only allow testing user override when GUREN_TESTING is explicitly set.
  // This prevents external callers from bypassing auth in production/staging.
  if (!process.env.GUREN_TESTING) {
    return null
  }

  const rawUser = ctx.req.header(TESTING_USER_HEADER)
  if (!rawUser) {
    return null
  }

  try {
    const parsed = JSON.parse(rawUser) as Record<string, unknown>
    // Re-attach Authenticatable methods lost during JSON serialization.
    // The serialized payload includes __authId (the pre-serialized identifier)
    // so we can reconstruct a conforming object.
    const authId = parsed.__authId ?? parsed.id ?? null
    return {
      ...parsed,
      getAuthIdentifier: () => authId,
      getAuthPassword: () => (parsed.password as string | null | undefined) ?? null,
    } as unknown as Authenticatable
  } catch {
    return null
  }
}

function withTestingUser(auth: AuthContext, testingUser: Authenticatable | null): AuthContext {
  if (!testingUser) {
    return auth
  }

  return {
    ...auth,
    check: async () => true,
    guest: async () => false,
    user: async <T = Authenticatable>() => testingUser as T,
    userOrFail: async <T = Authenticatable>() => testingUser as T,
    id: async () => testingUser.getAuthIdentifier(),
    login: async () => {},
    attempt: async () => true,
    logout: async () => {},
    // Preserve prototype methods lost by the object spread
    guard: auth.guard.bind(auth),
    session: auth.session.bind(auth),
  }
}

export function attachAuthContext(contextFactory: (ctx: Context) => AuthContext): MiddlewareHandler {
  return async (ctx, next) => {
    const auth = contextFactory(ctx)
    ctx.set(AUTH_CONTEXT_KEY, withTestingUser(auth, resolveTestingUser(ctx)))
    await next()
  }
}

function resolveAuth(ctx: { get: (key: string) => unknown }): AuthContext | undefined {
  return ctx.get(AUTH_CONTEXT_KEY) as AuthContext | undefined
}

export function requireAuthenticated(options: RequireAuthOptions = {}): MiddlewareHandler {
  const { redirectTo, status = 401, responseFactory } = options

  return stampCapabilities(async (ctx, next) => {
    const auth = resolveAuth(ctx)

    if (!auth) {
      throw new Error('Auth context has not been attached. Did you register the auth middleware?')
    }

    if (!(await auth.check())) {
      if (redirectTo) {
        return ctx.redirect(redirectTo)
      }

      if (responseFactory) {
        return responseFactory()
      }

      return jsonResponse({ message: 'Unauthorized' }, status)
    }

    await next()
  }, { authentication: { mode: 'required' } })
}

export function requireGuest(options: RequireAuthOptions = {}): MiddlewareHandler {
  const { redirectTo, status = 403, responseFactory } = options

  return stampCapabilities(async (ctx, next) => {
    const auth = resolveAuth(ctx)

    if (!auth) {
      throw new Error('Auth context has not been attached. Did you register the auth middleware?')
    }

    if (!(await auth.guest())) {
      if (redirectTo) {
        return ctx.redirect(redirectTo)
      }

      if (responseFactory) {
        return responseFactory()
      }

      return jsonResponse({ message: 'Already authenticated' }, status)
    }

    await next()
  }, { authentication: { mode: 'guest-only' } })
}

export { AUTH_CONTEXT_KEY }
