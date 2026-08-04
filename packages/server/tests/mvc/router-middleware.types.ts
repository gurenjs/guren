import type { MiddlewareHandler } from 'hono'
import { requireVerifiedEmail } from '../../src/auth/email-verification'
import { Controller } from '../../src/mvc/Controller'
import { Router } from '../../src/mvc/Router'

/**
 * A type-only fixture: none of these routers is ever mounted, and `bun run
 * typecheck` is the assertion. `Router.middleware()` and
 * `RouteBuilder.middleware()` used to accept registered alias names only, so
 * every call shape below failed with `Argument of type 'MiddlewareHandler' is
 * not assignable to parameter of type 'never'` — while four guides across both
 * doc languages documented exactly these shapes.
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

/** Chained onto a single route. */
export const routeLevelInline = new Router()
  .post('/login', [DemoController, 'store'])
  .middleware(rateLimiter)

/** Chained onto a route registered inside a named group. */
export const groupScopedRouteInline = new Router()
  .aliasMiddleware('auth', auditLogger)
  .middleware('auth')
  .group((group) => {
    group.get('/api/*', [DemoController, 'index']).middleware(rateLimiter)
  })

/** Alias names and handlers in the same call, at both levels. */
export const mixedNamedAndInline = new Router()
  .aliasMiddleware('auth', auditLogger)
  .middleware('auth', rateLimiter)
  .group((group) => {
    group.post('/posts', [DemoController, 'store']).middleware('auth', auditLogger)
  })

/**
 * Transcribed from the email-verification guide, whose `getUser` reads `ctx` —
 * impossible against the option's previous `(ctx: unknown)` signature, a second
 * reason that documented snippet did not compile. The cast mirrors the guide:
 * `get()` returns `unknown` by design, so the caller names the type.
 */
export const verifiedEmailGuard = new Router()
  .get('/profile', [DemoController, 'index'])
  .middleware(
    requireVerifiedEmail({
      redirectTo: '/verify-email',
      getUser: async (ctx) => {
        return ctx.get('user') as { emailVerifiedAt?: Date | null } | null
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
