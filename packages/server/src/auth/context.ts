import type { AuthContext } from './types'

/**
 * Context key the framework auth context is stored under.
 *
 * Lives here rather than in `http/middleware/auth` so that `auth/` modules can
 * import it without reaching back into the middleware layer. The middleware
 * re-exports it, and it stays a public root export.
 */
export const AUTH_CONTEXT_KEY = 'guren:auth'

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
