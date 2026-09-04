import type { MiddlewareHandler } from 'hono'
import { requireVerifiedEmail } from '../../src/auth/email-verification'
import { Controller } from '../../src/mvc/Controller'
import { Router } from '../../src/mvc/Router'

/**
 * A type-only fixture: nothing here is mounted and `bun run typecheck` is the
 * assertion. `Router.middleware()` / `RouteBuilder.middleware()` once took
 * registered alias names only, rejecting every shape below — all documented.
 */

class DemoController extends Controller {
  async index() {
    return this.json({})
  }

  async store() {
    return this.json({})
  }
}

const rateLimiter: MiddlewareHandler = async (_ctx, next) => {
  await next()
}

const auditLogger: MiddlewareHandler = async (_ctx, next) => {
  await next()
}

/** Router-level scope on a router with no registered aliases (`M = never`). */
export const routerLevelInline = new Router().middleware(rateLimiter).group((group) => {
  group.get('/api/items', [DemoController, 'index'])
})

export const routeLevelInline = new Router()
  .post('/login', [DemoController, 'store'])
  .middleware(rateLimiter)

export const groupScopedRouteInline = new Router()
  .aliasMiddleware('auth', auditLogger)
  .middleware('auth')
  .group((group) => {
    group.get('/api/*', [DemoController, 'index']).middleware(rateLimiter)
  })

export const mixedNamedAndInline = new Router()
  .aliasMiddleware('auth', auditLogger)
  .middleware('auth', rateLimiter)
  .group((group) => {
    group.post('/posts', [DemoController, 'store']).middleware('auth', auditLogger)
  })

/**
 * Transcribed verbatim from the email-verification guide: `getUser` reads
 * `ctx`, impossible against the option's previous `(ctx: unknown)` signature.
 * `ctx.get` is generic, so the return type is inferred and the guide needs no cast.
 */
export const verifiedEmailGuard = new Router()
  .get('/profile', [DemoController, 'index'])
  .middleware(
    requireVerifiedEmail({
      redirectTo: '/verify-email',
      getUser: async (ctx) => {
        return ctx.get('user')
      },
    }),
  )

/** A callback written against the previous `(ctx: unknown)` signature still compiles. */
const legacyGetUser = async (ctx: unknown) =>
  (ctx as { get(key: string): unknown }).get('user') as { emailVerifiedAt?: Date | null } | null

export const verifiedEmailLegacyCallback = requireVerifiedEmail({ getUser: legacyGetUser })

/** Unregistered alias names stay rejected — the widening is additive. */
export const unregisteredAliasRejected = new Router().aliasMiddleware('auth', auditLogger)
// @ts-expect-error 'nope' is not a registered alias on this router
unregisteredAliasRejected.middleware('nope')
