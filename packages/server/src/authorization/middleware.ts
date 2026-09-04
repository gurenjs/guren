import type { Context } from '../http/Application'
import type { Middleware } from '../http/middleware'
import type { AuthorizeOptions, AuthorizeResourceOptions } from './types'
import { Gate, getGate, denialToException } from './Gate'
import { AuthorizationException } from '../errors'
import { stampCapabilities } from '../http/middleware/capabilities'

/**
 * Middleware to authorize an ability. An array argument is snapshotted at
 * creation, and a one-element array behaves exactly like the bare ability.
 * An empty array denies every request (`Gate.any([])` is false) — fail-closed,
 * so it is left to run rather than rejected.
 */
export function authorizeMiddleware(
  ability: string | string[],
  modelResolver?: (ctx: Context) => unknown | Promise<unknown>,
  options: AuthorizeOptions = {}
): Middleware {
  // One snapshot feeds both the handler and the stamp, so they cannot disagree.
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
      // Keep the policy's own message and status, so a denial reads the same
      // here as through `Controller.authorize()`.
      const response = await gateForUser.checkResponse(abilities[0]!, user, model)
      if (!response.allowed) {
        throw denialToException(options.message ? { ...response, message: options.message } : response)
      }
    }

    await next()
  }, {
    // One ability normalizes to 'all'; see `MiddlewareCapabilities.authorization`.
    authorization: { abilities, mode: anyOf ? 'any' : 'all' },
  })
}

/**
 * Middleware to authorize all given abilities. The array is snapshotted at creation.
 *
 * @throws if no ability is given: `Gate.all([])` is vacuously true, so an empty
 * list would advertise authorization and enforce none (RFC 0016).
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

// QUERY (RFC 10008) is safe like GET, so it reads as 'view' — the same
// classification the CSRF middleware and `guren audit` apply. Uppercase keys
// cannot collide with Object.prototype, so a plain lookup is safe here.
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
 * The single source of the verb → ability mapping; `undefined` for a method it
 * refuses to guess at. A consumer resolving a route's ability from its stamped
 * `authorization.resource` capability calls this rather than restating the
 * table, and may only do so when `resource.fromMethodMap` is true. Internal
 * contract (RFC 0007): not re-exported from the package root.
 */
export function resourceAbilityForMethod(method: string): string | undefined {
  return RESOURCE_ABILITY_BY_METHOD[method.toUpperCase()]
}

/**
 * Maps HTTP methods to policy abilities. A method outside the built-in mapping
 * (a custom verb via `router.on()`) is denied with a 403 rather than downgraded
 * to `view`: guessing would let a view-only user reach a mutating handler. Map
 * custom verbs explicitly with `options.abilityFor`.
 */
export function authorizeResourceMiddleware(
  modelResolver: (ctx: Context) => unknown | Promise<unknown>,
  options: AuthorizeResourceOptions = {}
): Middleware {
  // Captured once: the stamp's `fromMethodMap` is fixed at creation, so a
  // caller assigning `options.abilityFor` later must not override it.
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
    // `abilityFor` is consulted *before* the verb map and wins for standard
    // methods too, so its presence makes the map non-authoritative here.
    authorization: {
      abilities: [],
      mode: 'all',
      resource: { fromMethodMap: abilityFor === undefined },
    },
  })
}

/** Create a gate-aware context with authorization helpers. */
export function withAuthorization(gate: Gate): Middleware {
  return async (ctx, next) => {
    const user = await gate.resolveUser(ctx)
    const gateForUser = gate.forUser(user)

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

export interface AuthorizedContext extends Context {
  get(key: 'gate'): Gate
  get(key: 'can'): (ability: string, ...args: unknown[]) => Promise<boolean>
  get(key: 'cannot'): (ability: string, ...args: unknown[]) => Promise<boolean>
  get(key: 'authorize'): (ability: string, ...args: unknown[]) => Promise<void>
}
