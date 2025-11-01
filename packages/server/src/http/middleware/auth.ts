import type { Context, MiddlewareHandler } from 'hono'
import type { AuthContext } from '../../auth'
export type { AuthContext } from '../../auth'

export interface RequireAuthOptions {
  redirectTo?: string
  status?: number
  responseFactory?: () => Response
}

const AUTH_CONTEXT_KEY = 'guren:auth'

export function attachAuthContext(contextFactory: (ctx: Context) => AuthContext): MiddlewareHandler {
  return async (ctx, next) => {
    ctx.set(AUTH_CONTEXT_KEY, contextFactory(ctx))
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

      return new Response(JSON.stringify({ message: 'Unauthorized' }), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      })
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

      return new Response(JSON.stringify({ message: 'Already authenticated' }), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      })
    }

    await next()
  }
}

export { AUTH_CONTEXT_KEY }
