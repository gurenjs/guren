import type { Context } from '../http/Application'
import type { Middleware } from '../http/middleware'
import type { AuthorizeOptions, AuthorizeResourceOptions } from './types'
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
 *
 * An array argument is snapshotted at creation: mutating it afterwards
 * changes neither what the middleware checks nor what it reports. A
 * one-element array is treated exactly like the bare ability, denial message
 * and status included. An empty array denies every request (`Gate.any([])` is
 * false) and names no ability — fail-closed, so it is left to run rather than
 * rejected.
 */
export function authorizeMiddleware(
  ability: string | string[],
  modelResolver?: (ctx: Context) => unknown | Promise<unknown>,
  options: AuthorizeOptions = {}
): Middleware {
  // One snapshot feeds both the handler and the stamp, so a caller mutating
  // the array it passed cannot make the two disagree.
  const abilities = Array.isArray(ability) ? [...ability] : [ability]
  const anyOf = abilities.length !== 1

  return stampCapabilities(async (ctx, next) => {
    const gate = getGate()
    const user = await gate.resolveUser(ctx)
    const gateForUser = gate.forUser(user)

    const model = modelResolver ? await modelResolver(ctx) : undefined

    if (anyOf) {
      // Any-of has no single response to carry, so a denial can only be generic.
      if (!(await gateForUser.any(abilities, model))) {
        throw new AuthorizationException(options.message ?? 'This action is unauthorized.')
      }
    } else {
      // Exactly one ability, however it was written: keep the policy's own
      // message and status, so the same denial reads the same here as through
      // `Controller.authorize()`.
      const response = await gateForUser.checkResponse(abilities[0]!, user, model)
      if (!response.allowed) {
        throw denialToException(options.message ? { ...response, message: options.message } : response)
      }
    }

    await next()
  }, {
    // One ability normalizes to 'all' whichever way it was written; see
    // `MiddlewareCapabilities.authorization` for why.
    authorization: { abilities, mode: anyOf ? 'any' : 'all' },
  })
}

/**
 * Middleware to authorize all given abilities.
 *
 * The array is snapshotted at creation, so mutating it afterwards changes
 * neither what the middleware checks nor what it reports.
 *
 * @throws if no ability is given. `Gate.all([])` is vacuously true, so an
 * empty list would mount a route that advertises authorization and enforces
 * none — the fail-open shape RFC 0016's "authn is not authz" rule exists to
 * catch. Refusing at creation surfaces it at boot rather than per request.
 */
export function authorizeAllMiddleware(
  input: string[],
  modelResolver?: (ctx: Context) => unknown | Promise<unknown>,
  options: AuthorizeOptions = {}
): Middleware {
  const abilities = [...input]

  if (abilities.length === 0) {
    throw new Error(
      'authorizeAllMiddleware() requires at least one ability: an empty list authorizes every request while claiming to authorize.'
    )
  }

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
  }, { authorization: { abilities, mode: 'all' } })
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
  // Captured once: the stamp's `fromMethodMap` is fixed at creation, so the
  // handler must not read `options.abilityFor` again per request — a caller
  // assigning it later would otherwise override the map the stamp still
  // reports as authoritative.
  const abilityFor = options.abilityFor

  return stampCapabilities(async (ctx, next) => {
    const method = ctx.req.method.toUpperCase()
    const ability = abilityFor?.(method) ?? resourceAbilityForMethod(method)

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
      resource: { fromMethodMap: abilityFor === undefined },
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
