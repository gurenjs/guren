import type { Context } from 'hono'
import type { AuthContext } from './types'
import { AuthenticationException } from '../errors/exceptions/AuthenticationException'

/**
 * Context key the framework auth context is stored under.
 *
 * Lives here rather than in `http/middleware/auth` so that `auth/` modules can
 * import it without reaching back into the middleware layer. The middleware
 * re-exports it, and it stays a public root export.
 */
export const AUTH_CONTEXT_KEY = 'guren:auth'

/**
 * Context key the principal a middleware already resolved is stored under.
 *
 * The framework auth context answers from this slot before it reaches a guard,
 * so a middleware that authenticates a request (the bearer-token middleware,
 * or an app's own) reaches the Gate whatever order it is mounted in.
 */
export const RESOLVED_PRINCIPAL_KEY = 'guren:resolved-principal'

/**
 * An identity a middleware established for this one request.
 *
 * `user` is null when the credential verified but its user cannot be loaded:
 * the request is then unauthenticated, not merely unresolved.
 */
export interface ResolvedPrincipal {
  user: unknown
  id: unknown
  source: string
  /** Invalidate the presented credential. `logout()` calls it. */
  revoke?: () => Promise<void>
}

/**
 * Read the framework auth context off a request context. `ctx.get` returns
 * arbitrary values for unknown keys, so the cast is a claim, not a check. A
 * caller whose behavior turns on a real auth context probes the member it is
 * about to call, as `Gate.resolveUser` does before its legacy `ctx.get('user')`
 * fallback; probing here would reject contexts `requireAuthenticated` can use.
 */
export function getAuthContext(ctx: { get: (key: string) => unknown }): AuthContext | undefined {
  return ctx.get(AUTH_CONTEXT_KEY) as AuthContext | undefined
}

export function getResolvedPrincipal(ctx: { get: (key: string) => unknown }): ResolvedPrincipal | undefined {
  return ctx.get(RESOLVED_PRINCIPAL_KEY) as ResolvedPrincipal | undefined
}

export function setResolvedPrincipal(ctx: Context, principal: ResolvedPrincipal | undefined): void {
  ctx.set(RESOLVED_PRINCIPAL_KEY, principal)
}

/**
 * The auth context a request carries when a middleware resolved a principal and
 * nothing attached a framework context — a bearer-authenticated route on a
 * plain Hono app. Credential flows throw rather than pretending to succeed;
 * `logout()` revokes the presented credential.
 */
export function createPrincipalAuthContext(ctx: Context): AuthContext {
  const unsupported = (method: string): never => {
    throw new Error(`${method}() is not available on a request with no auth context attached.`)
  }
  const principal = () => getResolvedPrincipal(ctx)

  return {
    check: async () => principal()?.user != null,
    guest: async () => principal()?.user == null,
    user: async <T>() => (principal()?.user ?? null) as T | null,
    userOrFail: async <T>() => {
      const user = principal()?.user
      if (user == null) throw new AuthenticationException()
      return user as T
    },
    id: async () => {
      const resolved = principal()
      return resolved?.user == null ? null : resolved.id
    },
    login: async () => unsupported('login'),
    attempt: async () => unsupported('attempt'),
    logout: async () => {
      await principal()?.revoke?.()
      setResolvedPrincipal(ctx, undefined)
    },
    guard: () => unsupported('guard'),
    session: () => undefined,
  }
}
