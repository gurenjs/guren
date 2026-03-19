import type { Context, MiddlewareHandler } from 'hono'
import type { Authenticatable, AuthContext } from '../../auth'
import { jsonResponse } from './index'
export type { AuthContext } from '../../auth'

export interface RequireAuthOptions {
  redirectTo?: string
  status?: number
  responseFactory?: () => Response
}

const AUTH_CONTEXT_KEY = 'guren:auth'
const TESTING_USER_HEADER = 'x-testing-user'

function resolveTestingUser(ctx: Context): Authenticatable | null {
  const rawUser = ctx.req.header(TESTING_USER_HEADER)
  if (!rawUser) {
    return null
  }

  try {
    return JSON.parse(rawUser) as Authenticatable
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
    id: async () => testingUser.getAuthIdentifier(),
    login: async () => {},
    attempt: async () => true,
    logout: async () => {},
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

  return async (ctx, next) => {
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
  }
}

export function requireGuest(options: RequireAuthOptions = {}): MiddlewareHandler {
  const { redirectTo, status = 403, responseFactory } = options

  return async (ctx, next) => {
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
  }
}

export { AUTH_CONTEXT_KEY }
