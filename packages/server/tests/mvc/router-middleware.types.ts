import type { MiddlewareHandler } from 'hono'
import { requireVerifiedEmail } from '../../src/auth/email-verification'
import type { RouteRegistration } from '../../src/http/Application'
import { Controller } from '../../src/mvc/Controller'
import { Router, type RouteBuilder } from '../../src/mvc/Router'

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
 * Method parameters are compared bivariantly, so without `RouteBuilder`'s
 * `in M` a `Router<never>` flows into a `Router<'auth'>` slot and fails at
 * `mount()`. Annotated, the parameter is contravariant: a router needing the
 * alias rejects one that never registered it, one with extra aliases passes.
 */
export function registrarNeedingAuth(router: Router<'auth'>): void {
  router.middleware('auth').get('/dashboard', [DemoController, 'index'])
}

// A bare `new Router()` in argument position would infer `M` from the parameter, so hold it first.
const plainRouter = new Router()
// @ts-expect-error a router that never aliased 'auth' cannot satisfy a registrar that reads it
registrarNeedingAuth(plainRouter)

/**
 * The residual hole, pinned as compiling: an inline `new Router()` has no
 * annotation to fix `M`, so it is inferred from the parameter and the missing
 * alias still reaches `mount()`. Contravariance cannot close this; only a
 * router whose `M` is already fixed is checked.
 */
registrarNeedingAuth(new Router())

// @ts-expect-error 'guest' and 'auth' are disjoint literals, rejected either way round — not a variance case
registrarNeedingAuth(new Router().aliasMiddleware('guest', auditLogger))

registrarNeedingAuth(new Router().aliasMiddleware('auth', auditLogger))
registrarNeedingAuth(new Router().aliasMiddleware('auth', auditLogger).aliasMiddleware('guest', rateLimiter))

/** A `RouteBuilder` carries the same alias set, and the same annotation. */
export function builderNeedingAuth(builder: RouteBuilder<'auth'>): void {
  builder.middleware('auth')
}
const plainBuilder = new Router().get('/health', [DemoController, 'index'])
// @ts-expect-error a builder from a router without 'auth' cannot satisfy one that reads it
builderNeedingAuth(plainBuilder)
builderNeedingAuth(new Router().aliasMiddleware('auth', auditLogger).get('/dashboard', [DemoController, 'index']))

/**
 * `RouteRegistration` names `Router`: an entry registrar is handed a bare one
 * and registers the aliases itself, so a registrar that annotates aliases does
 * not fit that slot. `createApp({ routes })` takes the outer one.
 */
// @ts-expect-error a registrar reading 'auth' cannot be the app's entry registrar
export const authRegistrarAsEntry: RouteRegistration = registrarNeedingAuth

/** `Router<string>` asks for every possible alias, so nothing satisfies it. Spell "any aliases" `Router`. */
export function registrarNeedingEveryAlias(router: Router<string>): void {
  router.get('/health', [DemoController, 'index'])
}
// @ts-expect-error a router carrying one alias does not carry all of them
registrarNeedingEveryAlias(new Router().aliasMiddleware('auth', auditLogger))

/** A `group()` callback cannot annotate aliases the router it is opened on lacks. */
export function groupCallbackWideningAliases(router: Router<'auth'>): void {
  // @ts-expect-error the callback reads 'guest', which this router never registered
  router.middleware('auth').group((inner: Router<'auth' | 'guest'>) => {
    inner.get('/dashboard', [DemoController, 'index'])
  })
}

/** The documented flow: capture the return, which carries the alias in its type. */
export function documentedFlow(baseRouter: Router): void {
  const router = baseRouter.aliasMiddleware('auth', auditLogger)
  registrarNeedingAuth(router)
  router.middleware('auth').group((authed) => {
    authed.get('/dashboard', [DemoController, 'index'])
  })
}

/** A registrar that needs no alias accepts any router, the direction `registerAttachmentRoutes(router)` relies on. */
export function registrarNeedingNone(router: Router): void {
  router.get('/health', [DemoController, 'index'])
}
registrarNeedingNone(new Router().aliasMiddleware('auth', auditLogger))

/** Exercises the scope-builder path; its contravariance comes from the private `Router<M>` field. */
export function scopeNeedingAuth(scope: ReturnType<Router<'auth'>['middleware']>): void {
  scope.get('/dashboard', [DemoController, 'index'])
}
// @ts-expect-error a scope opened on a router without 'auth' cannot stand in for one that has it
scopeNeedingAuth(new Router().middleware(rateLimiter))
scopeNeedingAuth(new Router().aliasMiddleware('auth', auditLogger).middleware('auth'))
