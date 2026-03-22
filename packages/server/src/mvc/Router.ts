import type { Context, MiddlewareHandler, Hono } from 'hono'
import { Controller } from './Controller'
import type { Container } from '../container/Container'
import { mountRoute } from './mount-route'
import { formatValidationErrors, parseRequestPayload, type ValidationErrorLike } from '../http/request'
import type { ValidationSchema } from '../http/middleware/validation'

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

export type RouteResult =
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

type SchemaLike<T = unknown> = ValidationSchema<T> | undefined
type InferSchema<TSchema extends SchemaLike<unknown>> =
  TSchema extends ValidationSchema<infer TValue> ? TValue : never
type RouteParamsFor<TSchema extends SchemaLike<unknown>> =
  [TSchema] extends [ValidationSchema<any>] ? InferSchema<TSchema> : Record<string, string>
type RouteQueryFor<TSchema extends SchemaLike<unknown>> =
  [TSchema] extends [ValidationSchema<any>] ? InferSchema<TSchema> : Record<string, string | undefined>
type RouteBodyFor<TSchema extends SchemaLike<unknown>> =
  [TSchema] extends [ValidationSchema<any>] ? InferSchema<TSchema> : Record<string, unknown>

export interface TypedRouteContext<
  TParamsSchema extends SchemaLike<unknown>,
  TQuerySchema extends SchemaLike<unknown>,
  TBodySchema extends SchemaLike<unknown>,
> {
  ctx: Context
  params: RouteParamsFor<TParamsSchema>
  query: RouteQueryFor<TQuerySchema>
  body: RouteBodyFor<TBodySchema>
}

export type TypedRouteHandler<
  TParamsSchema extends SchemaLike<unknown>,
  TQuerySchema extends SchemaLike<unknown>,
  TBodySchema extends SchemaLike<unknown>,
  TOutputSchema extends SchemaLike<unknown>,
> = (
  input: TypedRouteContext<TParamsSchema, TQuerySchema, TBodySchema>,
) => ([TOutputSchema] extends [ValidationSchema<any>] ? InferSchema<TOutputSchema> : RouteResult)
  | Promise<[TOutputSchema] extends [ValidationSchema<any>] ? InferSchema<TOutputSchema> : RouteResult>

export interface RouteContractOptions<
  TParamsSchema extends SchemaLike<unknown> = undefined,
  TQuerySchema extends SchemaLike<unknown> = undefined,
  TBodySchema extends SchemaLike<unknown> = undefined,
  TOutputSchema extends SchemaLike<unknown> = undefined,
> {
  name?: string
  middlewares?: MiddlewareHandler[]
  params?: TParamsSchema
  query?: TQuerySchema
  body?: TBodySchema
  output?: TOutputSchema
  bind?: Record<string, BindableModel>
}

interface RegisteredRoute {
  method: string
  path: string
  handler: AnyRouteHandler
  middlewares: MiddlewareHandler[]
  name?: string
  routeMiddlewareNames: string[]
  schemas?: {
    params?: SchemaLike<unknown>
    query?: SchemaLike<unknown>
    body?: SchemaLike<unknown>
    output?: SchemaLike<unknown>
  }
  bindings?: Map<string, BindableModel>
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
  /** Schema metadata attached via RouteContractOptions */
  schemas?: {
    params?: SchemaLike<unknown>
    query?: SchemaLike<unknown>
    body?: SchemaLike<unknown>
    output?: SchemaLike<unknown>
  }
}

/**
 * Chainable builder for configuring a registered route.
 */
export interface RouteBuilder {
  /** Set the route name for URL generation. */
  name(routeName: string): RouteBuilder
  /** Attach named middleware to this specific route. */
  middleware(...names: string[]): RouteBuilder
}

export interface RouterMountOptions {
  container?: Container
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

/**
 * Instance-based router for app-local route registration and mounting.
 */
export class Router {
  private readonly registry: RegisteredRoute[] = []
  private readonly prefixStack: string[] = []
  private readonly namedRoutes: Map<string, RegisteredRoute> = new Map()
  private readonly middlewareStack: string[][] = []
  private readonly middlewareAliases: Map<string, MiddlewareHandler> = new Map()
  private readonly middlewareGroups: Map<string, string[]> = new Map()
  private readonly modelBindings: Map<string, ModelBindingResolver> = new Map()

  aliasMiddleware(name: string, handler: MiddlewareHandler): this {
    this.middlewareAliases.set(name, handler)
    return this
  }

  groupMiddleware(name: string, middlewareNames: string[]): this {
    this.middlewareGroups.set(name, middlewareNames)
    return this
  }

  middleware(...names: string[]): RouterMiddlewareGroupBuilder {
    return new RouterMiddlewareGroupBuilder(this, names)
  }

  bind(param: string, modelOrResolver: BindableModel | ModelBindingResolver): this {
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

  on<C extends ControllerConstructor>(method: string, path: string, handler: RouteHandler<C>, ...middlewares: MiddlewareHandler[]): RouteBuilder
  on<
    TParamsSchema extends SchemaLike<unknown>,
    TQuerySchema extends SchemaLike<unknown>,
    TBodySchema extends SchemaLike<unknown>,
    TOutputSchema extends SchemaLike<unknown>,
  >(
    method: string,
    path: string,
    options: RouteContractOptions<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
    handler: TypedRouteHandler<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
  ): RouteBuilder
  on<
    C extends ControllerConstructor,
    TParamsSchema extends SchemaLike<unknown>,
    TQuerySchema extends SchemaLike<unknown>,
    TBodySchema extends SchemaLike<unknown>,
    TOutputSchema extends SchemaLike<unknown>,
  >(
    method: string,
    path: string,
    options: RouteContractOptions<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
    handler: ControllerAction<C>,
  ): RouteBuilder
  on(method: string, path: string, handlerOrOptions: unknown, ...rest: unknown[]): RouteBuilder {
    return this.register(method.toUpperCase(), path, handlerOrOptions, rest)
  }

  get<C extends ControllerConstructor>(path: string, handler: RouteHandler<C>, ...middlewares: MiddlewareHandler[]): RouteBuilder
  get<
    TParamsSchema extends SchemaLike<unknown>,
    TQuerySchema extends SchemaLike<unknown>,
    TBodySchema extends SchemaLike<unknown>,
    TOutputSchema extends SchemaLike<unknown>,
  >(
    path: string,
    options: RouteContractOptions<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
    handler: TypedRouteHandler<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
  ): RouteBuilder
  get<
    C extends ControllerConstructor,
    TParamsSchema extends SchemaLike<unknown>,
    TQuerySchema extends SchemaLike<unknown>,
    TBodySchema extends SchemaLike<unknown>,
    TOutputSchema extends SchemaLike<unknown>,
  >(
    path: string,
    options: RouteContractOptions<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
    handler: ControllerAction<C>,
  ): RouteBuilder
  get(path: string, handlerOrOptions: unknown, ...rest: unknown[]): RouteBuilder {
    return this.register('GET', path, handlerOrOptions, rest)
  }

  post<C extends ControllerConstructor>(path: string, handler: RouteHandler<C>, ...middlewares: MiddlewareHandler[]): RouteBuilder
  post<
    TParamsSchema extends SchemaLike<unknown>,
    TQuerySchema extends SchemaLike<unknown>,
    TBodySchema extends SchemaLike<unknown>,
    TOutputSchema extends SchemaLike<unknown>,
  >(
    path: string,
    options: RouteContractOptions<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
    handler: TypedRouteHandler<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
  ): RouteBuilder
  post<
    C extends ControllerConstructor,
    TParamsSchema extends SchemaLike<unknown>,
    TQuerySchema extends SchemaLike<unknown>,
    TBodySchema extends SchemaLike<unknown>,
    TOutputSchema extends SchemaLike<unknown>,
  >(
    path: string,
    options: RouteContractOptions<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
    handler: ControllerAction<C>,
  ): RouteBuilder
  post(path: string, handlerOrOptions: unknown, ...rest: unknown[]): RouteBuilder {
    return this.register('POST', path, handlerOrOptions, rest)
  }

  put<C extends ControllerConstructor>(path: string, handler: RouteHandler<C>, ...middlewares: MiddlewareHandler[]): RouteBuilder
  put<
    TParamsSchema extends SchemaLike<unknown>,
    TQuerySchema extends SchemaLike<unknown>,
    TBodySchema extends SchemaLike<unknown>,
    TOutputSchema extends SchemaLike<unknown>,
  >(
    path: string,
    options: RouteContractOptions<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
    handler: TypedRouteHandler<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
  ): RouteBuilder
  put<
    C extends ControllerConstructor,
    TParamsSchema extends SchemaLike<unknown>,
    TQuerySchema extends SchemaLike<unknown>,
    TBodySchema extends SchemaLike<unknown>,
    TOutputSchema extends SchemaLike<unknown>,
  >(
    path: string,
    options: RouteContractOptions<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
    handler: ControllerAction<C>,
  ): RouteBuilder
  put(path: string, handlerOrOptions: unknown, ...rest: unknown[]): RouteBuilder {
    return this.register('PUT', path, handlerOrOptions, rest)
  }

  patch<C extends ControllerConstructor>(path: string, handler: RouteHandler<C>, ...middlewares: MiddlewareHandler[]): RouteBuilder
  patch<
    TParamsSchema extends SchemaLike<unknown>,
    TQuerySchema extends SchemaLike<unknown>,
    TBodySchema extends SchemaLike<unknown>,
    TOutputSchema extends SchemaLike<unknown>,
  >(
    path: string,
    options: RouteContractOptions<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
    handler: TypedRouteHandler<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
  ): RouteBuilder
  patch<
    C extends ControllerConstructor,
    TParamsSchema extends SchemaLike<unknown>,
    TQuerySchema extends SchemaLike<unknown>,
    TBodySchema extends SchemaLike<unknown>,
    TOutputSchema extends SchemaLike<unknown>,
  >(
    path: string,
    options: RouteContractOptions<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
    handler: ControllerAction<C>,
  ): RouteBuilder
  patch(path: string, handlerOrOptions: unknown, ...rest: unknown[]): RouteBuilder {
    return this.register('PATCH', path, handlerOrOptions, rest)
  }

  delete<C extends ControllerConstructor>(path: string, handler: RouteHandler<C>, ...middlewares: MiddlewareHandler[]): RouteBuilder
  delete<
    TParamsSchema extends SchemaLike<unknown>,
    TQuerySchema extends SchemaLike<unknown>,
    TBodySchema extends SchemaLike<unknown>,
    TOutputSchema extends SchemaLike<unknown>,
  >(
    path: string,
    options: RouteContractOptions<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
    handler: TypedRouteHandler<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
  ): RouteBuilder
  delete<
    C extends ControllerConstructor,
    TParamsSchema extends SchemaLike<unknown>,
    TQuerySchema extends SchemaLike<unknown>,
    TBodySchema extends SchemaLike<unknown>,
    TOutputSchema extends SchemaLike<unknown>,
  >(
    path: string,
    options: RouteContractOptions<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
    handler: ControllerAction<C>,
  ): RouteBuilder
  delete(path: string, handlerOrOptions: unknown, ...rest: unknown[]): RouteBuilder {
    return this.register('DELETE', path, handlerOrOptions, rest)
  }

  group(prefix: string, callback: (router: Router) => void): this {
    this.prefixStack.push(prefix)
    callback(this)
    this.prefixStack.pop()
    return this
  }

  route(name: string, params: Record<string, string | number> = {}): string {
    const route = this.namedRoutes.get(name)
    if (!route) {
      throw new Error(`Route [${name}] not defined.`)
    }

    return substituteParams(route.path, params)
  }

  hasRoute(name: string): boolean {
    return this.namedRoutes.has(name)
  }

  resource<C extends ControllerConstructor>(
    path: string,
    controller: C,
    options: ResourceRouteOptions = {},
  ): this {
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

  mount(app: Hono, options: RouterMountOptions = {}): void {
    for (const route of this.registry) {
      const resolvedMiddlewares = this.resolveMiddlewareNames(route.routeMiddlewareNames)
      const handler = resolveHandler(route.handler, this.modelBindings, options.container, route.bindings)
      mountRoute(app, route.method, route.path, ...resolvedMiddlewares, ...route.middlewares, handler)
    }
  }

  clear(): void {
    this.registry.splice(0, this.registry.length)
    this.namedRoutes.clear()
    this.prefixStack.splice(0, this.prefixStack.length)
    this.middlewareStack.splice(0, this.middlewareStack.length)
  }

  resetMiddleware(): void {
    this.middlewareAliases.clear()
    this.middlewareGroups.clear()
    this.modelBindings.clear()
  }

  definitions(): RouteDefinition[] {
    return this.registry.map(({ method, path, name, schemas }) => ({ method, path, name, schemas }))
  }

  applyMiddlewareScope<T>(names: string[], callback: () => T): T {
    this.middlewareStack.push(names)
    try {
      return callback()
    } finally {
      this.middlewareStack.pop()
    }
  }

  private register(
    method: string,
    path: string,
    handlerOrOptions: unknown,
    rest: unknown[],
  ): RouteBuilder {
    if (isRouteContractOptions(handlerOrOptions)) {
      const options = handlerOrOptions as RouteContractOptions
      const [handlerOrAction] = rest

      // Contract options + controller action: validate at route level, delegate to controller
      if (isControllerAction(handlerOrAction as AnyRouteHandler)) {
        const builder = this.add(method, path, handlerOrAction as AnyControllerAction, options.middlewares ?? [])
        if (options.name) builder.name(options.name)
        // Store schemas for codegen extraction
        const route = this.registry[this.registry.length - 1]
        route.schemas = { params: options.params, query: options.query, body: options.body, output: options.output }
        if (options.bind) {
          route.bindings = new Map(Object.entries(options.bind))
        }
        return builder
      }

      // Contract options + typed handler function
      const contractHandler = handlerOrAction as TypedRouteHandler<SchemaLike<unknown>, SchemaLike<unknown>, SchemaLike<unknown>, SchemaLike<unknown>>
      if (typeof contractHandler !== 'function') {
        throw new Error(`Router.${method.toLowerCase()} requires a handler function when route contract options are provided.`)
      }

      const wrappedHandler = createContractHandler(path, options, contractHandler)
      const builder = this.add(method, path, wrappedHandler, options.middlewares ?? [])

      if (options.name) {
        builder.name(options.name)
      }

      const route = this.registry[this.registry.length - 1]
      route.schemas = { params: options.params, query: options.query, body: options.body, output: options.output }
      if (options.bind) {
        route.bindings = new Map(Object.entries(options.bind))
      }
      return builder
    }

    return this.add(method, path, handlerOrOptions as AnyRouteHandler, rest as MiddlewareHandler[])
  }

  private add(method: string, path: string, handler: AnyRouteHandler, middlewares: MiddlewareHandler[] = []): RouteBuilder {
    const fullPath = joinPaths(this.prefixStack, path)
    const stackMiddleware = this.middlewareStack.flat()
    const route: RegisteredRoute = {
      method,
      path: fullPath,
      handler,
      middlewares,
      routeMiddlewareNames: [...stackMiddleware],
    }

    this.registry.push(route)
    return createRouteBuilder(route, this.namedRoutes)
  }

  private resolveMiddlewareNames(names: string[], seen?: Set<string>): MiddlewareHandler[] {
    const handlers: MiddlewareHandler[] = []
    const visited = seen ?? new Set<string>()

    for (const name of names) {
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

      const handler = this.middlewareAliases.get(name)
      if (handler) {
        handlers.push(handler)
        continue
      }

      throw new Error(`Middleware "${name}" is not registered. Use router.aliasMiddleware() to register it.`)
    }

    return handlers
  }
}

class RouterMiddlewareGroupBuilder {
  constructor(
    private readonly router: Router,
    private readonly names: string[],
  ) {}

  group(callback: (router: Router) => void): Router {
    return this.router.applyMiddlewareScope(this.names, () => {
      callback(this.router)
      return this.router
    })
  }

  get<C extends ControllerConstructor>(path: string, handler: RouteHandler<C>, ...middlewares: MiddlewareHandler[]): RouteBuilder
  get<
    TParamsSchema extends SchemaLike<unknown>,
    TQuerySchema extends SchemaLike<unknown>,
    TBodySchema extends SchemaLike<unknown>,
    TOutputSchema extends SchemaLike<unknown>,
  >(
    path: string,
    options: RouteContractOptions<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
    handler: TypedRouteHandler<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
  ): RouteBuilder
  get(path: string, handlerOrOptions: unknown, ...rest: unknown[]): RouteBuilder {
    return this.router.applyMiddlewareScope(this.names, () => this.router.get(path, handlerOrOptions as never, ...(rest as never[])))
  }

  post<C extends ControllerConstructor>(path: string, handler: RouteHandler<C>, ...middlewares: MiddlewareHandler[]): RouteBuilder
  post<
    TParamsSchema extends SchemaLike<unknown>,
    TQuerySchema extends SchemaLike<unknown>,
    TBodySchema extends SchemaLike<unknown>,
    TOutputSchema extends SchemaLike<unknown>,
  >(
    path: string,
    options: RouteContractOptions<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
    handler: TypedRouteHandler<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
  ): RouteBuilder
  post(path: string, handlerOrOptions: unknown, ...rest: unknown[]): RouteBuilder {
    return this.router.applyMiddlewareScope(this.names, () => this.router.post(path, handlerOrOptions as never, ...(rest as never[])))
  }

  put<C extends ControllerConstructor>(path: string, handler: RouteHandler<C>, ...middlewares: MiddlewareHandler[]): RouteBuilder
  put<
    TParamsSchema extends SchemaLike<unknown>,
    TQuerySchema extends SchemaLike<unknown>,
    TBodySchema extends SchemaLike<unknown>,
    TOutputSchema extends SchemaLike<unknown>,
  >(
    path: string,
    options: RouteContractOptions<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
    handler: TypedRouteHandler<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
  ): RouteBuilder
  put(path: string, handlerOrOptions: unknown, ...rest: unknown[]): RouteBuilder {
    return this.router.applyMiddlewareScope(this.names, () => this.router.put(path, handlerOrOptions as never, ...(rest as never[])))
  }

  patch<C extends ControllerConstructor>(path: string, handler: RouteHandler<C>, ...middlewares: MiddlewareHandler[]): RouteBuilder
  patch<
    TParamsSchema extends SchemaLike<unknown>,
    TQuerySchema extends SchemaLike<unknown>,
    TBodySchema extends SchemaLike<unknown>,
    TOutputSchema extends SchemaLike<unknown>,
  >(
    path: string,
    options: RouteContractOptions<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
    handler: TypedRouteHandler<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
  ): RouteBuilder
  patch(path: string, handlerOrOptions: unknown, ...rest: unknown[]): RouteBuilder {
    return this.router.applyMiddlewareScope(this.names, () => this.router.patch(path, handlerOrOptions as never, ...(rest as never[])))
  }

  delete<C extends ControllerConstructor>(path: string, handler: RouteHandler<C>, ...middlewares: MiddlewareHandler[]): RouteBuilder
  delete<
    TParamsSchema extends SchemaLike<unknown>,
    TQuerySchema extends SchemaLike<unknown>,
    TBodySchema extends SchemaLike<unknown>,
    TOutputSchema extends SchemaLike<unknown>,
  >(
    path: string,
    options: RouteContractOptions<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
    handler: TypedRouteHandler<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
  ): RouteBuilder
  delete(path: string, handlerOrOptions: unknown, ...rest: unknown[]): RouteBuilder {
    return this.router.applyMiddlewareScope(this.names, () => this.router.delete(path, handlerOrOptions as never, ...(rest as never[])))
  }
}

function createRouteBuilder(route: RegisteredRoute, namedRoutes: Map<string, RegisteredRoute>): RouteBuilder {
  return {
    name(routeName: string): RouteBuilder {
      route.name = routeName
      namedRoutes.set(routeName, route)
      return this
    },
    middleware(...names: string[]): RouteBuilder {
      route.routeMiddlewareNames.push(...names)
      return this
    },
  }
}

function substituteParams(path: string, params: Record<string, string | number>): string {
  return path.replace(/:([A-Za-z0-9_-]+)/gu, (match, key) => {
    if (!Object.prototype.hasOwnProperty.call(params, key)) {
      return match
    }

    return encodeURIComponent(String(params[key]))
  })
}

function createContractHandler<
  TParamsSchema extends SchemaLike<unknown>,
  TQuerySchema extends SchemaLike<unknown>,
  TBodySchema extends SchemaLike<unknown>,
  TOutputSchema extends SchemaLike<unknown>,
>(
  path: string,
  options: RouteContractOptions<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
  handler: TypedRouteHandler<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
): (ctx: Context) => Promise<RouteResult> {
  return async (ctx) => {
    const params = parseRouteSegment(options.params, ctx.req.param(), 400)
    if (params instanceof Response) {
      return params
    }

    const query = parseRouteSegment(options.query, ctx.req.query(), 422)
    if (query instanceof Response) {
      return query
    }

    const payload = options.body ? await parseRequestPayload(ctx) : {}
    const body = parseRouteSegment(options.body, payload, 422)
    if (body instanceof Response) {
      return body
    }

    const result = await handler({
      ctx,
      params: params as RouteParamsFor<TParamsSchema>,
      query: query as RouteQueryFor<TQuerySchema>,
      body: body as RouteBodyFor<TBodySchema>,
    })

    if (!options.output) {
      return result as RouteResult
    }

    const output = options.output.safeParse(result)
    if (output.success) {
      return output.data as RouteResult
    }

    throw new Error(
      `Route output validation failed for ${options.name ?? path}: ${JSON.stringify(formatValidationErrors(output.error))}`,
    )
  }
}

function parseRouteSegment<T>(
  schema: ValidationSchema<T> | undefined,
  data: unknown,
  status: number,
): T | Response {
  if (!schema) {
    return data as T
  }

  const result = schema.safeParse(data)
  if (result.success) {
    return result.data
  }

  return validationErrorResponse(result.error, status)
}

function validationErrorResponse(error: ValidationErrorLike, status: number): Response {
  return new Response(JSON.stringify({ errors: formatValidationErrors(error) }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

function resolveHandler(
  action: AnyRouteHandler,
  modelBindings: Map<string, ModelBindingResolver>,
  container?: Container,
  routeBindings?: Map<string, BindableModel>,
): MiddlewareHandler {
  if (isControllerAction(action)) {
    const [ControllerClass, methodName] = action
    return async (c) => {
      const inject = ControllerClass.inject
      let controller: Controller

      if (inject && inject.length > 0 && container) {
        try {
          const deps = inject.map((key) => container.make(key))
          controller = new ControllerClass(...deps)
        } catch {
          controller = new ControllerClass()
        }
      } else {
        controller = new ControllerClass()
      }

      controller.setContext(c)
      if (container) {
        controller.setContainer(container)
      }

      // Resolve per-route model bindings (from RouteContractOptions.bind)
      if (routeBindings && routeBindings.size > 0) {
        const params = c.req.param() as Record<string, string>
        for (const [paramName, model] of routeBindings) {
          const value = params[paramName]
          if (value !== undefined) {
            const resolved = await model.findOrFail(value)
            controller.setResolvedModel(model, resolved)
          }
        }
      }

      const method = controller[methodName]
      if (typeof method !== 'function') {
        throw new Error(`Controller method ${String(methodName)} is not defined on ${ControllerClass.name}.`)
      }

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

function isRouteContractOptions(value: unknown): value is RouteContractOptions<SchemaLike<unknown>, SchemaLike<unknown>, SchemaLike<unknown>, SchemaLike<unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  return 'params' in value || 'query' in value || 'body' in value || 'output' in value || 'name' in value || 'middlewares' in value
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
