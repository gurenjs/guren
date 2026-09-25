import type { Context, MiddlewareHandler } from 'hono'
import type { Authenticatable, AuthContext } from '../../auth/types'
import { AUTH_CONTEXT_KEY, getAuthContext } from '../../auth/context'
import { jsonResponse } from './index'
import { stampCapabilities } from './capabilities'
import { isAgentToolRequest } from '../../internal/agent-request'
export type { AuthContext } from '../../auth/types'

export interface RequireAuthOptions {
  redirectTo?: string
  status?: number
  responseFactory?: () => Response
}

const TESTING_USER_HEADER = 'x-testing-user'

function resolveTestingUser(ctx: Context): Authenticatable | null {
  // Gated on GUREN_TESTING, or an external caller could bypass auth in
  // production by sending the header.
  if (!process.env.GUREN_TESTING) {
    return null
  }

  const rawUser = ctx.req.header(TESTING_USER_HEADER)
  if (!rawUser) {
    return null
  }

  try {
    const parsed = JSON.parse(rawUser) as Record<string, unknown>
    // Re-attach the Authenticatable methods JSON dropped; `__authId` carries
    // the pre-serialized identifier.
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

function refuse(ctx: Context, options: RequireAuthOptions, status: number, message: string): Response {
  if (options.redirectTo) {
    // A tool caller cannot follow a redirect, and the dispatcher maps a 3xx to
    // a success result; `responseFactory` is skipped, since it may redirect too.
    return isAgentToolRequest(ctx) ? jsonResponse({ message }, status) : ctx.redirect(options.redirectTo)
  }
  return options.responseFactory ? options.responseFactory() : jsonResponse({ message }, status)
}

export function requireAuthenticated(options: RequireAuthOptions = {}): MiddlewareHandler {
  const { status = 401 } = options

  return stampCapabilities(async (ctx, next) => {
    const auth = getAuthContext(ctx)

    if (!auth) {
      throw new Error('Auth context has not been attached. Did you register the auth middleware?')
    }

    if (!(await auth.check())) {
      return refuse(ctx, options, status, 'Unauthorized')
    }

    await next()
  }, { authentication: { mode: 'required' } })
}

export function requireGuest(options: RequireAuthOptions = {}): MiddlewareHandler {
  const { status = 403 } = options

  return stampCapabilities(async (ctx, next) => {
    const auth = getAuthContext(ctx)

    if (!auth) {
      throw new Error('Auth context has not been attached. Did you register the auth middleware?')
    }

    if (!(await auth.guest())) {
      return refuse(ctx, options, status, 'Already authenticated')
    }

    await next()
  }, { authentication: { mode: 'guest-only' } })
}

export { AUTH_CONTEXT_KEY, getAuthContext }
