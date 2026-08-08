import type { Context } from '../http/Application'
import type { Middleware } from '../http/middleware'
import type { AuthUser, AuthorizeOptions } from './types'
import { Gate, getGate, denialToException } from './Gate'
import { AuthorizationException } from '../errors'

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
  return async (ctx, next) => {
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
  }
}

/**
 * Middleware to authorize all given abilities.
 */
export function authorizeAllMiddleware(
  abilities: string[],
  modelResolver?: (ctx: Context) => unknown | Promise<unknown>,
  options: AuthorizeOptions = {}
): Middleware {
  return async (ctx, next) => {
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
  }
}

/**
 * Middleware factory for resource authorization.
 * Automatically maps HTTP methods to policy abilities.
 *
 * @example
 * ```typescript
 * // Authorize resource actions based on HTTP method
 * app.use('/posts/:id', authorizeResourceMiddleware(getPost))
 * // GET -> view, POST -> create, PUT/PATCH -> update, DELETE -> delete
 * ```
 */
export function authorizeResourceMiddleware(
  modelResolver: (ctx: Context) => unknown | Promise<unknown>,
  options: AuthorizeOptions = {}
): Middleware {
  return async (ctx, next) => {
    const method = ctx.req.method.toUpperCase()

    // Map HTTP methods to policy abilities
    let ability: string
    switch (method) {
      case 'GET':
      case 'HEAD':
        ability = 'view'
        break
      case 'POST':
        ability = 'create'
        break
      case 'PUT':
      case 'PATCH':
        ability = 'update'
        break
      case 'DELETE':
        ability = 'delete'
        break
      default:
        ability = 'view'
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
  }
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
