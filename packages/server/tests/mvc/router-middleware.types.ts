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

/**
 * Method parameters are compared bivariantly, so without `Router`'s phantom
 * property a `Router<never>` flows into a `Router<'auth'>` slot and fails at
 * `mount()`. With it the parameter is contravariant: a router needing the
 * alias rejects one that never registered it, and one carrying extra aliases
 * still passes.
 */
export function registrarNeedingAuth(router: Router<'auth'>): void {
  router.middleware('auth').get('/dashboard', [DemoController, 'index'])
}

// A bare `new Router()` in argument position would infer `M` from the parameter, so hold it first.
const plainRouter = new Router()
// @ts-expect-error a router that never aliased 'auth' cannot satisfy a registrar that reads it
registrarNeedingAuth(plainRouter)

// @ts-expect-error nor can one that registered a different alias
registrarNeedingAuth(new Router().aliasMiddleware('guest', auditLogger))

registrarNeedingAuth(new Router().aliasMiddleware('auth', auditLogger))
registrarNeedingAuth(new Router().aliasMiddleware('auth', auditLogger).aliasMiddleware('guest', rateLimiter))

/** The documented flow: capture the return, which carries the alias in its type. */
export function documentedFlow(baseRouter: Router): void {
  const router = baseRouter.aliasMiddleware('auth', auditLogger)
  registrarNeedingAuth(router)
  router.middleware('auth').group((authed) => {
    authed.get('/dashboard', [DemoController, 'index'])
  })
}

/** Discarding the return keeps the parameter at `Router<never>`, which the registrar rejects. */
export function discardedReturn(baseRouter: Router): void {
  baseRouter.aliasMiddleware('auth', auditLogger)
  // @ts-expect-error the alias is registered at runtime but absent from `baseRouter`'s type
  registrarNeedingAuth(baseRouter)
}

/** A registrar that needs no alias accepts any router, the direction `registerAttachmentRoutes(router)` relies on. */
export function registrarNeedingNone(router: Router): void {
  router.get('/health', [DemoController, 'index'])
}
registrarNeedingNone(new Router().aliasMiddleware('auth', auditLogger))

/** The scope builder inherits the variance through the router it wraps. */
export function scopeNeedingAuth(scope: ReturnType<Router<'auth'>['middleware']>): void {
  scope.get('/dashboard', [DemoController, 'index'])
}
// @ts-expect-error a scope opened on a router without 'auth' cannot stand in for one that has it
scopeNeedingAuth(new Router().middleware(rateLimiter))
scopeNeedingAuth(new Router().aliasMiddleware('auth', auditLogger).middleware('auth'))
