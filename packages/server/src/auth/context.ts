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
 * Read the framework auth context off a request context.
 *
 * `ctx.get` returns arbitrary values for unknown keys, so the cast is a claim,
 * not a check. A caller whose behavior turns on the value really being an auth
 * context probes the member it is about to call (`Gate.resolveUser` does, since
 * a stray value there decides whether the legacy `ctx.get('user')` fallback
 * runs). Probing here would reject contexts `requireAuthenticated` can use.
 */
export function getAuthContext(ctx: { get: (key: string) => unknown }): AuthContext | undefined {
  return ctx.get(AUTH_CONTEXT_KEY) as AuthContext | undefined
}
