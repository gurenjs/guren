import type { Context } from '../http/Application'
import type { Middleware } from '../http/middleware'
import type { AuthUser, AuthorizeOptions, AuthorizeResourceOptions } from './types'
import { Gate, getGate, denialToException } from './Gate'
import { AuthorizationException } from '../errors'
import { stampCapabilities } from '../http/middleware/capabilities'

/**
 * Middleware to authorize an ability.
 *
 * @example
 * ```typescript
 * // Authorize a simple ability
 * app.get('/admin', authorizeMiddleware('admin'), adminHandler)
 *
 * // Authorize with model (from route param)
 * app.put('/posts/:id', authorizeMiddleware('update', getPost), updateHandler)
 *
 * // Multiple abilities (any)
 * app.get('/dashboard', authorizeMiddleware(['admin', 'moderator']), dashboardHandler)
 * ```
 */
export function authorizeMiddleware(
  ability: string | string[],
  modelResolver?: (ctx: Context) => unknown | Promise<unknown>,
  options: AuthorizeOptions = {}
): Middleware {
  return stampCapabilities(async (ctx, next) => {
    const gate = getGate()
    const user = await gate.resolveUser(ctx)
    const gateForUser = gate.forUser(user)

    const abilities = Array.isArray(ability) ? ability : [ability]
    const model = modelResolver ? await modelResolver(ctx) : undefined

    if (Array.isArray(ability)) {
      // Any-of has no single response to carry, so a denial can only be generic.
      if (!(await gateForUser.any(abilities, model))) {
        throw new AuthorizationException(options.message ?? 'This action is unauthorized.')
      }
    } else {
      // Single ability: keep the policy's own message and status, so the same
      // denial reads the same here as through `Controller.authorize()`.
      const response = await gateForUser.checkResponse(ability, user, model)
      if (!response.allowed) {
        throw denialToException(options.message ? { ...response, message: options.message } : response)
      }
    }

    await next()
  }, {
    // Mirrors the runtime branch above: an array is an any-of check, a
    // single ability is the one that has to hold.
    authorization: Array.isArray(ability)
      ? { abilities: [...ability], mode: 'any' }
      : { abilities: [ability], mode: 'all' },
  })
}

/**
 * Middleware to authorize all given abilities.
 */
export function authorizeAllMiddleware(
  abilities: string[],
  modelResolver?: (ctx: Context) => unknown | Promise<unknown>,
  options: AuthorizeOptions = {}
): Middleware {
  return stampCapabilities(async (ctx, next) => {
    const gate = getGate()
    const user = await gate.resolveUser(ctx)
    const gateForUser = gate.forUser(user)

    const model = modelResolver ? await modelResolver(ctx) : undefined
    const authorized = await gateForUser.all(abilities, model)

    if (!authorized) {
      throw new AuthorizationException(
        options.message ?? 'This action is unauthorized.'
      )
    }

    await next()
  }, { authorization: { abilities: [...abilities], mode: 'all' } })
}

// HTTP method → policy ability. QUERY (RFC 10008) is safe like GET, so it
// reads as 'view' — the same classification the CSRF middleware and
// `guren audit` apply. Uppercase keys cannot collide with Object.prototype
// properties, so a plain lookup is safe for arbitrary request methods.
const RESOURCE_ABILITY_BY_METHOD: Record<string, string> = {
  GET: 'view',
  HEAD: 'view',
  QUERY: 'view',
  POST: 'create',
  PUT: 'update',
  PATCH: 'update',
  DELETE: 'delete',
}

/**
 * The ability `authorizeResourceMiddleware` checks for an HTTP method, or
 * `undefined` for a method it refuses to guess at (which the middleware
 * denies). This is the single source of the verb → ability mapping: a
 * consumer resolving a route's ability from its stamped
 * `authorization.resource` capability calls this rather than restating the
 * table, and may only do so when `resource.fromMethodMap` is true.
 *
 * Not re-exported from the package root — like the capability stamp itself
 * (RFC 0007), this is an internal contract until a public consumer needs it.
 */
export function resourceAbilityForMethod(method: string): string | undefined {
  return RESOURCE_ABILITY_BY_METHOD[method.toUpperCase()]
}

/**
 * Middleware factory for resource authorization.
 * Automatically maps HTTP methods to policy abilities.
 *
 * Methods outside the built-in mapping (custom verbs registered via
 * `router.on()`) are denied with a 403 rather than downgraded to a `view`
 * check — the middleware cannot know whether an unknown verb mutates, so
 * guessing would let a view-only user reach a mutating handler. Map custom
 * verbs explicitly with `options.abilityFor`.
 *
 * @example
 * ```typescript
 * // Authorize resource actions based on HTTP method
 * app.use('/posts/:id', authorizeResourceMiddleware(getPost))
 * // GET/HEAD/QUERY -> view, POST -> create, PUT/PATCH -> update, DELETE -> delete
 *
 * // Custom verbs must be mapped explicitly, or they are denied
 * authorizeResourceMiddleware(getPost, {
 *   abilityFor: (method) => (method === 'PURGE' ? 'delete' : undefined),
 * })
 * ```
 */
export function authorizeResourceMiddleware(
  modelResolver: (ctx: Context) => unknown | Promise<unknown>,
  options: AuthorizeResourceOptions = {}
): Middleware {
  return stampCapabilities(async (ctx, next) => {
    const method = ctx.req.method.toUpperCase()
    const ability = options.abilityFor?.(method) ?? RESOURCE_ABILITY_BY_METHOD[method]

    if (ability === undefined) {
      throw new AuthorizationException(options.message ?? 'This action is unauthorized.')
    }

    const gate = getGate()
    const user = await gate.resolveUser(ctx)
    const gateForUser = gate.forUser(user)

    const model = await modelResolver(ctx)
    const response = await gateForUser.checkResponse(ability, user, model)

    if (!response.allowed) {
      throw denialToException(options.message ? { ...response, message: options.message } : response)
    }

    await next()
  }, {
    // The ability is only known once a request arrives. `abilityFor` is
    // consulted *before* the verb map and wins for standard methods too, so
    // its presence makes the map non-authoritative for this route — say so
    // rather than letting a consumer report the mapped ability for a check
    // that never uses it.
    authorization: {
      abilities: [],
      mode: 'all',
      resource: { fromMethodMap: options.abilityFor === undefined },
    },
  })
}

/**
 * Create a gate-aware context with authorization helpers.
 */
export function withAuthorization(gate: Gate): Middleware {
  return async (ctx, next) => {
    const user = await gate.resolveUser(ctx)
    const gateForUser = gate.forUser(user)

    // Add authorization helpers to context
    ctx.set('gate', gateForUser)
    ctx.set('can', async (ability: string, ...args: unknown[]) => {
      return gateForUser.allows(ability, ...args)
    })
    ctx.set('cannot', async (ability: string, ...args: unknown[]) => {
      return gateForUser.denies(ability, ...args)
    })
    ctx.set('authorize', async (ability: string, ...args: unknown[]) => {
      return gateForUser.authorize(ability, ...args)
    })

    await next()
  }
}

/**
 * Helper type for context with authorization.
 */
export interface AuthorizedContext extends Context {
  get(key: 'gate'): Gate
  get(key: 'can'): (ability: string, ...args: unknown[]) => Promise<boolean>
  get(key: 'cannot'): (ability: string, ...args: unknown[]) => Promise<boolean>
  get(key: 'authorize'): (ability: string, ...args: unknown[]) => Promise<void>
}
