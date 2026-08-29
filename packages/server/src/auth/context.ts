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
 * Duck-typed on purpose: `ctx.get` returns arbitrary values for unknown keys —
 * test doubles and exotic contexts included — so a bare cast hands out values
 * that are not auth contexts at all. The `user` probe is a cheap sanity check,
 * not validation: an object shaped like an auth context is taken at its word.
 */
export function getAuthContext(ctx: { get: (key: string) => unknown }): AuthContext | undefined {
  const auth = ctx.get(AUTH_CONTEXT_KEY) as AuthContext | undefined
  return auth && typeof auth.user === 'function' ? auth : undefined
}
