import type { Context, MiddlewareHandler, Hono } from 'hono'
import { Controller } from './Controller'
import { getContainer } from '../container/Container'
import { mountRoute } from './mount-route'

/**
 * Constructor type for Controller classes.
 * @template T - The controller type extending Controller
 */
export type ControllerConstructor<T extends Controller = Controller> = (new (...args: any[]) => T) & {
  inject?: readonly string[]
}
type ControllerMethod<T extends Controller> = {
  [K in keyof T]: T[K] extends (...args: any[]) => any ? K : never
}[keyof T] & string
type ControllerMethodFor<C extends ControllerConstructor> = ControllerMethod<InstanceType<C>>
export type ControllerAction<C extends ControllerConstructor = ControllerConstructor> = [C, ControllerMethodFor<C>]
type AnyControllerConstructor = ControllerConstructor<Controller>
type AnyControllerAction = ControllerAction<AnyControllerConstructor>
type RouteResult =
  | Response
  | string
  | number
  | boolean
  | Record<string, unknown>
  | Array<unknown>
  | null
  | void
/**
 * Handler for a route - either an inline function or a controller action tuple.
 */
export type RouteHandler<C extends ControllerConstructor = ControllerConstructor> =
  | ((c: Context) => RouteResult | Promise<RouteResult>)
  | ControllerAction<C>
type AnyRouteHandler = ((c: Context) => RouteResult | Promise<RouteResult>) | AnyControllerAction

/**
 * Model binding resolver function.
 */
type ModelBindingResolver = (value: string) => Promise<unknown>

/**
 * Model class with findOrFail static method.
 */
interface BindableModel {
  findOrFail(id: unknown, key?: string): Promise<unknown>
}

interface RegisteredRoute {
  method: string
  path: string
  handler: AnyRouteHandler
  middlewares: MiddlewareHandler[]
  name?: string
  routeMiddlewareNames: string[]
}

/**
 * Represents a registered route definition for introspection.
 */
export interface RouteDefinition {
  /** HTTP method (GET, POST, PUT, PATCH, DELETE) */
  method: string
  /** URL path pattern (e.g., '/users/:id') */
  path: string
  /** Optional route name for URL generation */
  name?: string
}

const ROUTE_REGISTRY_KEY = '__guren_route_registry__'
const ROUTE_PREFIX_STACK_KEY = '__guren_route_prefix_stack__'
const ROUTE_NAMES_KEY = '__guren_route_names__'
const ROUTE_MIDDLEWARE_STACK_KEY = '__guren_route_middleware_stack__'

type RouteGlobalState = {
  [ROUTE_REGISTRY_KEY]?: RegisteredRoute[]
  [ROUTE_PREFIX_STACK_KEY]?: string[]
  [ROUTE_NAMES_KEY]?: Map<string, RegisteredRoute>
  [ROUTE_MIDDLEWARE_STACK_KEY]?: string[][]
}

const routeGlobal = globalThis as RouteGlobalState

routeGlobal[ROUTE_REGISTRY_KEY] ??= []
routeGlobal[ROUTE_PREFIX_STACK_KEY] ??= []
routeGlobal[ROUTE_NAMES_KEY] ??= new Map()
routeGlobal[ROUTE_MIDDLEWARE_STACK_KEY] ??= []

/**
 * Chainable builder for configuring a registered route.
 */
export interface RouteBuilder {
  /** Set the route name for URL generation. */
  name(routeName: string): RouteBuilder
  /** Attach named middleware to this specific route. */
  middleware(...names: string[]): RouteBuilder
}

function createRouteBuilder(route: RegisteredRoute): RouteBuilder {
  return {
    name(routeName: string): RouteBuilder {
      route.name = routeName
      routeGlobal[ROUTE_NAMES_KEY]!.set(routeName, route)
      return this
    },
    middleware(...names: string[]): RouteBuilder {
      route.routeMiddlewareNames.push(...names)
      return this
    },
  }
}

const RESOURCE_ACTIONS = [
  { method: 'index', suffix: '', httpMethod: 'get' },
  { method: 'create', suffix: '/create', httpMethod: 'get' },
  { method: 'store', suffix: '', httpMethod: 'post' },
  { method: 'show', suffix: '/:param', httpMethod: 'get' },
  { method: 'edit', suffix: '/:param/edit', httpMethod: 'get' },
  { method: 'update', suffix: '/:param', httpMethod: 'put' },
  { method: 'destroy', suffix: '/:param', httpMethod: 'delete' },
] as const

/**
 * Laravel-style route registry for defining application routes.
 *
 * Routes are registered declaratively and mounted onto a Hono application.
 * Supports inline handlers, controller actions, middleware, groups, and named routes.
 *
 * @example
 * // Basic routes
 * Route.get('/', () => 'Hello World')
 * Route.post('/users', [UserController, 'store'])
 *
 * // Middleware groups
 * Route.middleware('auth').group(() => {
 *   Route.get('/dashboard', [DashboardController, 'index'])
 * })
 *
 * // Route model binding
 * Route.bind('post', Post)
 * Route.get('/posts/:post', [PostController, 'show'])
 */
export class Route {
  private static readonly registry: RegisteredRoute[] = routeGlobal[ROUTE_REGISTRY_KEY]!
  private static readonly prefixStack: string[] = routeGlobal[ROUTE_PREFIX_STACK_KEY]!
  private static readonly namedRoutes: Map<string, RegisteredRoute> = routeGlobal[ROUTE_NAMES_KEY]!
  private static readonly middlewareStack: string[][] = routeGlobal[ROUTE_MIDDLEWARE_STACK_KEY]!

  /** Named middleware aliases: 'auth' → MiddlewareHandler */
  private static middlewareAliases: Map<string, MiddlewareHandler> = new Map()

  /** Middleware groups: 'web' → ['session', 'csrf', 'shareInertia'] */
  private static middlewareGroups: Map<string, string[]> = new Map()

  /** Route model bindings: 'post' → resolver function */
  private static modelBindings: Map<string, ModelBindingResolver> = new Map()

  // ─── Middleware Configuration ───────────────────────────────────

  /**
   * Register a named middleware alias.
   *
   * @example
   * Route.aliasMiddleware('auth', requireAuthenticated())
   * Route.aliasMiddleware('admin', requireRole('admin'))
   */
  static aliasMiddleware(name: string, handler: MiddlewareHandler): typeof Route {
    this.middlewareAliases.set(name, handler)
    return this
  }

  /**
   * Register a middleware group.
   *
   * @example
   * Route.groupMiddleware('web', ['session', 'csrf', 'shareInertia'])
   * Route.groupMiddleware('api', ['throttle'])
   */
  static groupMiddleware(name: string, middlewareNames: string[]): typeof Route {
    this.middlewareGroups.set(name, middlewareNames)
    return this
  }

  /**
   * Create a middleware scope. Routes defined inside the callback
   * will have the specified middleware applied.
   *
   * @example
   * Route.middleware('auth').group(() => {
   *   Route.get('/dashboard', [DashboardController, 'index'])
   * })
   *
   * // Nest groups
   * Route.middleware('web').group(() => {
   *   Route.middleware('auth').group(() => {
   *     Route.get('/settings', [SettingsController, 'index'])
   *   })
   * })
   */
  static middleware(...names: string[]): MiddlewareGroupBuilder {
    return new MiddlewareGroupBuilder(names)
  }

  // ─── Route Model Binding ────────────────────────────────────────

  /**
   * Register a route model binding.
   *
   * @example
   * // Bind to a Model class (uses findOrFail)
   * Route.bind('post', Post)
   *
   * // Bind with custom resolver
   * Route.bind('post', async (value) => Post.where('slug', value).firstOrFail())
   */
  static bind(param: string, modelOrResolver: BindableModel | ModelBindingResolver): typeof Route {
    if (typeof modelOrResolver === 'function') {
      this.modelBindings.set(param, modelOrResolver as ModelBindingResolver)
    } else {
      const model = modelOrResolver
      this.modelBindings.set(param, async (value: string) => {
        return model.findOrFail(value)
      })
    }
    return this
  }

  // ─── Route Registration ─────────────────────────────────────────

  private static add<C extends ControllerConstructor>(
    method: string,
    path: string,
    handler: RouteHandler<C>,
    middlewares: MiddlewareHandler[] = [],
  ): RouteBuilder {
    const fullPath = joinPaths(this.prefixStack, path)
    // Collect middleware names from the current stack
    const stackMiddleware = this.middlewareStack.flat()
    const route: RegisteredRoute = {
      method,
      path: fullPath,
      handler: handler as AnyRouteHandler,
      middlewares,
      routeMiddlewareNames: [...stackMiddleware],
    }
    this.registry.push(route)
    return createRouteBuilder(route)
  }

  /**
   * Register a route with a custom HTTP method.
   */
  static on<C extends ControllerConstructor>(method: string, path: string, handler: RouteHandler<C>, ...middlewares: MiddlewareHandler[]): RouteBuilder {
    return this.add(method.toUpperCase(), path, handler, middlewares)
  }

  static get<C extends ControllerConstructor>(path: string, handler: RouteHandler<C>, ...middlewares: MiddlewareHandler[]): RouteBuilder {
    return this.add('GET', path, handler, middlewares)
  }

  static post<C extends ControllerConstructor>(path: string, handler: RouteHandler<C>, ...middlewares: MiddlewareHandler[]): RouteBuilder {
    return this.add('POST', path, handler, middlewares)
  }

  static put<C extends ControllerConstructor>(path: string, handler: RouteHandler<C>, ...middlewares: MiddlewareHandler[]): RouteBuilder {
    return this.add('PUT', path, handler, middlewares)
  }

  static patch<C extends ControllerConstructor>(path: string, handler: RouteHandler<C>, ...middlewares: MiddlewareHandler[]): RouteBuilder {
    return this.add('PATCH', path, handler, middlewares)
  }

  static delete<C extends ControllerConstructor>(path: string, handler: RouteHandler<C>, ...middlewares: MiddlewareHandler[]): RouteBuilder {
    return this.add('DELETE', path, handler, middlewares)
  }

  /**
   * Group routes under a common prefix.
   */
  static group(prefix: string, callback: () => void): typeof Route {
    this.prefixStack.push(prefix)
    callback()
    this.prefixStack.pop()
    return this
  }

  /**
   * Generate a URL for a named route with parameter substitution.
   */
  static route(name: string, params: Record<string, string | number> = {}): string {
    const route = this.namedRoutes.get(name)
    if (!route) {
      throw new Error(`Route [${name}] not defined.`)
    }
    return substituteParams(route.path, params)
  }

  /**
   * Check if a named route exists.
   */
  static hasRoute(name: string): boolean {
    return this.namedRoutes.has(name)
  }

  /**
   * Register RESTful resource routes for a controller.
   */
  static resource<C extends ControllerConstructor>(
    path: string,
    controller: C,
    options: ResourceRouteOptions = {},
  ): typeof Route {
    const baseName = options.name ?? path.replace(/^\//u, '').replace(/\//gu, '.')
    const paramName = options.param ?? 'id'
    const { only, except } = options

    for (const { method, suffix, httpMethod } of RESOURCE_ACTIONS) {
      if (only && !only.includes(method)) continue
      if (except?.includes(method)) continue

      const actualSuffix = suffix.replace(':param', `:${paramName}`)
      const routePath = path + actualSuffix

      if (typeof (controller.prototype as Record<string, unknown>)[method] === 'function') {
        this[httpMethod](routePath, [controller, method as ControllerMethodFor<C>]).name(`${baseName}.${method}`)
      }
    }

    return this
  }

  /**
   * Mount all registered routes onto a Hono application.
   */
  static mount(app: Hono): void {
    for (const route of this.registry) {
      const resolvedMiddlewares = this.resolveMiddlewareNames(route.routeMiddlewareNames)
      const handler = resolveHandler(route.handler, this.modelBindings)
      mountRoute(app, route.method, route.path, ...resolvedMiddlewares, ...route.middlewares, handler)
    }
  }

  /**
   * Clear all registered routes and named routes.
   */
  static clear(): void {
    this.registry.splice(0, this.registry.length)
    this.namedRoutes.clear()
    this.prefixStack.splice(0, this.prefixStack.length)
    this.middlewareStack.splice(0, this.middlewareStack.length)
  }

  /**
   * Reset all middleware aliases, groups, and model bindings.
   */
  static resetMiddleware(): void {
    this.middlewareAliases.clear()
    this.middlewareGroups.clear()
    this.modelBindings.clear()
  }

  /**
   * Get all registered route definitions for introspection.
   */
  static definitions(): RouteDefinition[] {
    return this.registry.map(({ method, path, name }) => ({ method, path, name }))
  }

  /**
   * Resolve middleware names (including groups) to actual handlers.
   */
  private static resolveMiddlewareNames(names: string[], seen?: Set<string>): MiddlewareHandler[] {
    const handlers: MiddlewareHandler[] = []
    const visited = seen ?? new Set<string>()

    for (const name of names) {
      // Check if it's a group
      const groupNames = this.middlewareGroups.get(name)
      if (groupNames) {
        if (visited.has(name)) {
          throw new Error(`Circular middleware group detected: "${name}"`)
        }
        const nextVisited = new Set(visited)
        nextVisited.add(name)
        handlers.push(...this.resolveMiddlewareNames(groupNames, nextVisited))
        continue
      }

      // Check if it's an alias
      const handler = this.middlewareAliases.get(name)
      if (handler) {
        handlers.push(handler)
        continue
      }

      throw new Error(`Middleware "${name}" is not registered. Use Route.aliasMiddleware() to register it.`)
    }

    return handlers
  }
}

/**
 * Builder for creating middleware-scoped route groups.
 */
class MiddlewareGroupBuilder {
  constructor(private readonly names: string[]) {}

  /**
   * Define routes within this middleware scope.
   */
  group(callback: () => void): typeof Route {
    const stack = routeGlobal[ROUTE_MIDDLEWARE_STACK_KEY]!
    stack.push(this.names)
    callback()
    stack.pop()
    return Route
  }

  // Shortcut methods for single routes with middleware
  get<C extends ControllerConstructor>(path: string, handler: RouteHandler<C>, ...middlewares: MiddlewareHandler[]): RouteBuilder {
    return this.wrapSingle(() => Route.get(path, handler, ...middlewares))
  }

  post<C extends ControllerConstructor>(path: string, handler: RouteHandler<C>, ...middlewares: MiddlewareHandler[]): RouteBuilder {
    return this.wrapSingle(() => Route.post(path, handler, ...middlewares))
  }

  put<C extends ControllerConstructor>(path: string, handler: RouteHandler<C>, ...middlewares: MiddlewareHandler[]): RouteBuilder {
    return this.wrapSingle(() => Route.put(path, handler, ...middlewares))
  }

  patch<C extends ControllerConstructor>(path: string, handler: RouteHandler<C>, ...middlewares: MiddlewareHandler[]): RouteBuilder {
    return this.wrapSingle(() => Route.patch(path, handler, ...middlewares))
  }

  delete<C extends ControllerConstructor>(path: string, handler: RouteHandler<C>, ...middlewares: MiddlewareHandler[]): RouteBuilder {
    return this.wrapSingle(() => Route.delete(path, handler, ...middlewares))
  }

  private wrapSingle(fn: () => RouteBuilder): RouteBuilder {
    const stack = routeGlobal[ROUTE_MIDDLEWARE_STACK_KEY]!
    stack.push(this.names)
    const builder = fn()
    stack.pop()
    return builder
  }
}

/**
 * Available actions for resource routes.
 */
export type ResourceAction = 'index' | 'create' | 'store' | 'show' | 'edit' | 'update' | 'destroy'

/**
 * Options for configuring resource routes.
 */
export interface ResourceRouteOptions {
  name?: string
  param?: string
  only?: ResourceAction[]
  except?: ResourceAction[]
}

function substituteParams(path: string, params: Record<string, string | number>): string {
  return path.replace(/:([A-Za-z0-9_-]+)/gu, (match, key) => {
    if (!Object.prototype.hasOwnProperty.call(params, key)) {
      return match
    }

    return encodeURIComponent(String(params[key]))
  })
}

function resolveHandler(
  action: AnyRouteHandler,
  modelBindings: Map<string, ModelBindingResolver>,
): MiddlewareHandler {
  if (isControllerAction(action)) {
    const [ControllerClass, methodName] = action
    return async (c) => {
      // Resolve dependencies from container if static inject is defined
      const inject = ControllerClass.inject
      let controller: Controller

      if (inject && inject.length > 0) {
        try {
          const container = getContainer()
          const deps = inject.map((key) => container.make(key))
          controller = new ControllerClass(...deps)
        } catch {
          controller = new ControllerClass()
        }
      } else {
        controller = new ControllerClass()
      }

      controller.setContext(c)

      const method = controller[methodName]
      if (typeof method !== 'function') {
        throw new Error(`Controller method ${String(methodName)} is not defined on ${ControllerClass.name}.`)
      }

      // Resolve model bindings from route params (skip if none registered)
      const resolvedBindings = modelBindings.size > 0
        ? await resolveModelBindings(c, modelBindings)
        : []

      const args: unknown[] = resolvedBindings.length > 0 ? [c, ...resolvedBindings] : [c]
      const result = await (method as (...a: unknown[]) => unknown).apply(controller, args)
      return ensureResponse(result)
    }
  }

  return async (c) => {
    const result = await action(c)
    return ensureResponse(result)
  }
}

async function resolveModelBindings(
  c: Context,
  modelBindings: Map<string, ModelBindingResolver>,
): Promise<unknown[]> {
  if (modelBindings.size === 0) {
    return []
  }

  const resolved: unknown[] = []
  // Extract route params from the path pattern
  const params = c.req.param()

  for (const [paramName, resolver] of modelBindings) {
    const value = params[paramName]
    if (value !== undefined) {
      const model = await resolver(value)
      resolved.push(model)
    }
  }

  return resolved
}

function ensureResponse(result: unknown): Response {
  if (result instanceof Response) {
    return result
  }

  if (result === undefined || result === null) {
    return new Response(null, { status: 204 })
  }

  if (typeof result === 'string') {
    return new Response(result, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  }

  if (typeof result === 'object') {
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  return new Response(String(result))
}

function isControllerAction(action: AnyRouteHandler): action is AnyControllerAction {
  return Array.isArray(action)
}

function joinPaths(prefixStack: string[], path: string): string {
  const segments = [...prefixStack, path]
    .filter(Boolean)
    .map((segment) => segment.replace(/\/*$/u, '').replace(/^\/*/u, ''))
    .filter(Boolean)

  if (segments.length === 0) {
    return '/'
  }

  const combined = segments.join('/')
  return '/' + combined.replace(/\/+/gu, '/')
}
