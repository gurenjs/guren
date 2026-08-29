import type { Context, MiddlewareHandler, Hono, Next } from 'hono'
import { Controller } from './Controller'
import type { Container } from '../container/Container'
import { mountRoute } from './mount-route'
import { flattenRequestQueries, formatValidationErrors, parseRequestPayload, type ValidationErrorLike } from '../http/request'
import { ValidationException } from '../errors/exceptions/ValidationException'
import type { ValidationSchema } from '../http/middleware/validation'
import { capabilitiesOf, type MiddlewareCapabilities } from '../http/middleware/capabilities'
import { trimSlashes } from '../support/trim-slashes'

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
 * Inline handlers receive `next`, so any Hono middleware (e.g.
 * `broadcast.sseMiddleware()`) can be mounted directly as a terminal handler.
 */
export type RouteHandler<C extends ControllerConstructor = ControllerConstructor> =
  | ((c: Context, next: Next) => RouteResult | Promise<RouteResult>)
  | ControllerAction<C>

type AnyRouteHandler = ((c: Context, next: Next) => RouteResult | Promise<RouteResult>) | AnyControllerAction

/**
 * Model binding resolver function.
 */
type ModelBindingResolver = (value: string) => Promise<unknown>

/**
 * Model class with findOrFail static method.
 */
export interface BindableModel {
  findOrFail(id: unknown, key?: string): Promise<unknown>
  /** Bound values are model classes at runtime; the constructor name is the introspection payload. */
  readonly name?: string
}

/**
 * A model bound to a route parameter: the model class alone looks the value
 * up by primary key (`Model.findOrFail(value)`); a `[Model, column]` tuple
 * looks it up by that column (`Model.findOrFail(value, column)`), e.g.
 * `bind: { slug: [Post, 'slug'] }`. Either way the controller reads the
 * resolved record with `this.model(Model)`.
 */
export type RouteModelBinding = BindableModel | readonly [BindableModel, string]

/** {@link RouteModelBinding} normalized for resolution. */
interface ModelBinding {
  model: BindableModel
  /** Column to look up by; `undefined` means the model's primary key. */
  key?: string
}

/**
 * A router-level `bind(param, ...)` entry. `model` is present when the
 * binding is a model (class or `[Model, column]`) — those records are also
 * handed to `Controller.model()` — and absent for custom resolvers, whose
 * value only reaches the action as a positional argument.
 */
interface RegisteredBinding {
  resolve: ModelBindingResolver
  model?: BindableModel
}

function normalizeModelBinding(binding: RouteModelBinding): ModelBinding {
  if (Array.isArray(binding)) {
    const [model, key] = binding as readonly [BindableModel, string]
    return { model, key }
  }
  return { model: binding as BindableModel }
}

async function resolveModelBinding({ model, key }: ModelBinding, value: string): Promise<unknown> {
  return key === undefined ? model.findOrFail(value) : model.findOrFail(value, key)
}

/**
 * A Resource class accepted as a response hint. Only the constructor name is
 * introspected — the router never instantiates it, so any class whose
 * instances expose `toJSON()` (every `Resource` subclass) qualifies.
 */
interface ResponseResourceClass {
  new (resource: any): { toJSON(): unknown }
}

/**
 * Type-level response hint for a route: a Resource class, a single-element
 * array of a hint (a collection), or a plain object of hints (an envelope,
 * e.g. `{ data: [PostResource] }`). Purely declarative — nothing is validated
 * at runtime. `guren codegen` maps each Resource class to the `Data` type it
 * extracts from `app/Http/Resources` and types the API client's `json()`
 * with the assembled shape.
 */
export type ResourceResponseHint =
  | ResponseResourceClass
  | readonly [ResourceResponseHint]
  | { readonly [key: string]: ResourceResponseHint }

/**
 * Serialized form of {@link ResourceResponseHint} carried by
 * {@link RouteDefinition}: Resource classes become their class names.
 */
export type ResourceResponseShape =
  | string
  | [ResourceResponseShape]
  | { [key: string]: ResourceResponseShape }

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
> extends RouteOpenApiMetadata {
  name?: string
  middlewares?: MiddlewareHandler[]
  params?: TParamsSchema
  query?: TQuerySchema
  body?: TBodySchema
  output?: TOutputSchema
  /**
   * Type-level response hint (see {@link ResourceResponseHint}). Unlike
   * `output`, nothing runs at request time — the route's JSON is assumed to
   * follow the shape. When both are set, `output` wins in generated types:
   * it is the one actually enforced.
   */
  resource?: ResourceResponseHint
  /**
   * Route model bindings: param name → model (see {@link RouteModelBinding}).
   * `{ id: Post }` resolves by primary key, `{ slug: [Post, 'slug'] }` by
   * that column; both throw the model's not-found exception (404) on a miss
   * and expose the record to the controller via `this.model(Post)`.
   */
  bind?: Record<string, RouteModelBinding>
}

export interface RouteOpenApiMetadata {
  summary?: string
  description?: string
  tags?: string[]
  operationId?: string
  deprecated?: boolean
}

interface RegisteredRoute {
  method: string
  path: string
  handler: AnyRouteHandler
  /** Handlers attached at this route's own registration. */
  middlewares: MiddlewareHandler[]
  /** Handlers inherited from the enclosing `middleware(handler).group(...)` scopes. */
  scopedMiddlewares: MiddlewareHandler[]
  name?: string
  routeMiddlewareNames: string[]
  schemas?: {
    params?: SchemaLike<unknown>
    query?: SchemaLike<unknown>
    body?: SchemaLike<unknown>
    output?: SchemaLike<unknown>
  }
  resource?: ResourceResponseHint
  openapi?: RouteOpenApiMetadata
  bindings?: Map<string, ModelBinding>
}

/**
 * Represents a registered route definition for introspection.
 */
export interface RouteDefinition {
  /** Uppercased HTTP method (GET, POST, PUT, PATCH, DELETE, QUERY, or any custom method registered via on()) */
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
  /**
   * Serialized response hint from `RouteContractOptions.resource` — Resource
   * class names in place of the classes. Absent when no hint was declared or
   * when any class in the hint has no usable name (a partially-typed response
   * would claim a shape the wire does not have).
   */
  resource?: ResourceResponseShape
  /** Named middleware (aliases or groups) applied to this route */
  middlewareNames?: string[]
  /** Whether inline (unnamed) middleware handlers are attached */
  hasInlineMiddleware?: boolean
  /**
   * Security capabilities aggregated from the route's middleware chain
   * (named aliases, groups, and inline handlers). Always present on routers
   * from this release — an empty object means "no recognized capability" —
   * so consumers can distinguish that from definitions produced by older
   * servers, where the field is absent. The value shape is internal and may
   * change (RFC 0007).
   */
  capabilities?: MiddlewareCapabilities
  /** Controller binding when the handler is a [Controller, 'method'] tuple */
  controller?: {
    name: string
    action: string
  }
  /** Route model bindings: param name → bound model class name (from `bind`) */
  bindings?: Record<string, string>
  summary?: string
  description?: string
  tags?: string[]
  operationId?: string
  deprecated?: boolean
}

/**
 * Chainable builder for configuring a registered route.
 * @template M - Union of registered middleware alias names
 */
export interface RouteBuilder<M extends string = never> {
  /** Set the route name for URL generation. */
  name(routeName: string): RouteBuilder<M>
  /** Attach middleware to this specific route. See {@link RouteMiddlewareInput}. */
  middleware(...items: RouteMiddlewareInput<M>[]): RouteBuilder<M>
}

/**
 * Accepted by `.middleware()`: a registered alias name or a handler function.
 *
 * Resolution is by kind, not by position: every name in a route's chain runs
 * before every handler, across scopes as well as within one call. So an inline
 * handler on an outer group runs *after* a named one on an inner group, the
 * reverse of how they read. Use aliases throughout when relative order matters.
 *
 * Aliases are also the only form that lands in `RouteDefinition.middlewareNames`,
 * which is how `guren audit` reports middleware it cannot otherwise identify.
 * Guards the framework stamps with a capability (`requireAuthenticated`,
 * `requireGuest`) are recognized either way.
 */
export type RouteMiddlewareInput<M extends string = never> = M | MiddlewareHandler

/** Storage form of {@link RouteMiddlewareInput}, unparameterized by alias union. */
type MiddlewareScopeEntry = string | MiddlewareHandler

/**
 * Group scopes are unwound synchronously, so an `async` callback registers its
 * routes after the scope has already been popped — silently dropping the
 * prefix or middleware the group was opened with. The callback type says
 * `=> void`, which TypeScript happily accepts an `async` function for, so this
 * has to be caught at runtime.
 */
function assertSyncGroupCallback(result: unknown, method: string): void {
  if (typeof (result as PromiseLike<unknown> | undefined)?.then !== 'function') return

  throw new Error(
    `Router.${method}() callback returned a promise. Group scopes are applied synchronously, `
    + 'so routes registered after an await would silently lose the group\'s prefix and middleware. '
    + 'Register the routes synchronously, and await anything they depend on before opening the group.',
  )
}

function partitionMiddleware(
  items: readonly MiddlewareScopeEntry[],
): { names: string[]; handlers: MiddlewareHandler[] } {
  const names: string[] = []
  const handlers: MiddlewareHandler[] = []

  for (const item of items) {
    if (typeof item === 'string') names.push(item)
    else handlers.push(item)
  }

  return { names, handlers }
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
 * @template M - Union of registered middleware alias names (e.g. `'auth' | 'guest'`)
 */
export class Router<M extends string = never> {
  private readonly registry: RegisteredRoute[] = []
  private readonly prefixStack: string[] = []
  private readonly namedRoutes: Map<string, RegisteredRoute> = new Map()
  private readonly middlewareStack: MiddlewareScopeEntry[][] = []
  private readonly middlewareAliases: Map<string, MiddlewareHandler> = new Map()
  private readonly middlewareGroups: Map<string, string[]> = new Map()
  private readonly modelBindings: Map<string, RegisteredBinding> = new Map()

  aliasMiddleware<N extends string>(name: N, handler: MiddlewareHandler): Router<M | N> {
    this.middlewareAliases.set(name, handler)
    return this as Router<M | N>
  }

  groupMiddleware<N extends string>(name: N, middlewareNames: M[]): Router<M | N> {
    this.middlewareGroups.set(name, middlewareNames)
    return this as Router<M | N>
  }

  /**
   * Open a middleware scope for the routes registered through the returned
   * builder. See {@link RouteMiddlewareInput}.
   */
  middleware(...items: RouteMiddlewareInput<M>[]): RouterMiddlewareGroupBuilder<M> {
    return new RouterMiddlewareGroupBuilder(this, items)
  }

  /**
   * Bind a route parameter for every route on this router whose path names
   * it. A model (class or `[Model, column]`) resolves through `findOrFail`
   * and reaches the controller both via `this.model(Model)` and as a
   * positional argument after the context; a custom resolver's value only
   * arrives positionally, in path-parameter order:
   *
   * ```ts
   * router.bind('post', async (slug) => Post.where('slug', slug).firstOrFail())
   * router.get('/posts/:post', [PostController, 'show'])
   *
   * async show(_ctx: Context, post: PostRecord) { ... }
   * ```
   */
  bind(param: string, modelOrResolver: RouteModelBinding | ModelBindingResolver): this {
    if (typeof modelOrResolver === 'function' && !('findOrFail' in modelOrResolver)) {
      this.modelBindings.set(param, { resolve: modelOrResolver as ModelBindingResolver })
      return this
    }

    // A model class, a `[Model, column]` tuple, or any object exposing findOrFail.
    const binding = normalizeModelBinding(modelOrResolver as RouteModelBinding)
    this.modelBindings.set(param, {
      model: binding.model,
      resolve: (value) => resolveModelBinding(binding, value),
    })
    return this
  }

  on<C extends ControllerConstructor>(method: string, path: string, handler: RouteHandler<C>, ...middlewares: MiddlewareHandler[]): RouteBuilder<M>
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
  ): RouteBuilder<M>
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
  ): RouteBuilder<M>
  on(method: string, path: string, handlerOrOptions: unknown, ...rest: unknown[]): RouteBuilder<M> {
    return this.register(method.toUpperCase(), path, handlerOrOptions, rest)
  }

  get<C extends ControllerConstructor>(path: string, handler: RouteHandler<C>, ...middlewares: MiddlewareHandler[]): RouteBuilder<M>
  get<
    TParamsSchema extends SchemaLike<unknown>,
    TQuerySchema extends SchemaLike<unknown>,
    TBodySchema extends SchemaLike<unknown>,
    TOutputSchema extends SchemaLike<unknown>,
  >(
    path: string,
    options: RouteContractOptions<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
    handler: TypedRouteHandler<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
  ): RouteBuilder<M>
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
  ): RouteBuilder<M>
  get(path: string, handlerOrOptions: unknown, ...rest: unknown[]): RouteBuilder<M> {
    return this.register('GET', path, handlerOrOptions, rest)
  }

  post<C extends ControllerConstructor>(path: string, handler: RouteHandler<C>, ...middlewares: MiddlewareHandler[]): RouteBuilder<M>
  post<
    TParamsSchema extends SchemaLike<unknown>,
    TQuerySchema extends SchemaLike<unknown>,
    TBodySchema extends SchemaLike<unknown>,
    TOutputSchema extends SchemaLike<unknown>,
  >(
    path: string,
    options: RouteContractOptions<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
    handler: TypedRouteHandler<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
  ): RouteBuilder<M>
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
  ): RouteBuilder<M>
  post(path: string, handlerOrOptions: unknown, ...rest: unknown[]): RouteBuilder<M> {
    return this.register('POST', path, handlerOrOptions, rest)
  }

  put<C extends ControllerConstructor>(path: string, handler: RouteHandler<C>, ...middlewares: MiddlewareHandler[]): RouteBuilder<M>
  put<
    TParamsSchema extends SchemaLike<unknown>,
    TQuerySchema extends SchemaLike<unknown>,
    TBodySchema extends SchemaLike<unknown>,
    TOutputSchema extends SchemaLike<unknown>,
  >(
    path: string,
    options: RouteContractOptions<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
    handler: TypedRouteHandler<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
  ): RouteBuilder<M>
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
  ): RouteBuilder<M>
  put(path: string, handlerOrOptions: unknown, ...rest: unknown[]): RouteBuilder<M> {
    return this.register('PUT', path, handlerOrOptions, rest)
  }

  patch<C extends ControllerConstructor>(path: string, handler: RouteHandler<C>, ...middlewares: MiddlewareHandler[]): RouteBuilder<M>
  patch<
    TParamsSchema extends SchemaLike<unknown>,
    TQuerySchema extends SchemaLike<unknown>,
    TBodySchema extends SchemaLike<unknown>,
    TOutputSchema extends SchemaLike<unknown>,
  >(
    path: string,
    options: RouteContractOptions<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
    handler: TypedRouteHandler<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
  ): RouteBuilder<M>
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
  ): RouteBuilder<M>
  patch(path: string, handlerOrOptions: unknown, ...rest: unknown[]): RouteBuilder<M> {
    return this.register('PATCH', path, handlerOrOptions, rest)
  }

  delete<C extends ControllerConstructor>(path: string, handler: RouteHandler<C>, ...middlewares: MiddlewareHandler[]): RouteBuilder<M>
  delete<
    TParamsSchema extends SchemaLike<unknown>,
    TQuerySchema extends SchemaLike<unknown>,
    TBodySchema extends SchemaLike<unknown>,
    TOutputSchema extends SchemaLike<unknown>,
  >(
    path: string,
    options: RouteContractOptions<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
    handler: TypedRouteHandler<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
  ): RouteBuilder<M>
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
  ): RouteBuilder<M>
  delete(path: string, handlerOrOptions: unknown, ...rest: unknown[]): RouteBuilder<M> {
    return this.register('DELETE', path, handlerOrOptions, rest)
  }

  /**
   * Registers a route for the HTTP QUERY method (RFC 10008): safe and
   * idempotent like GET, but the request carries a body like POST. Handlers
   * must not mutate state — CSRF protection deliberately skips QUERY on that
   * assumption (see `createCsrfMiddleware`'s `methods` option to opt in).
   */
  query<C extends ControllerConstructor>(path: string, handler: RouteHandler<C>, ...middlewares: MiddlewareHandler[]): RouteBuilder<M>
  query<
    TParamsSchema extends SchemaLike<unknown>,
    TQuerySchema extends SchemaLike<unknown>,
    TBodySchema extends SchemaLike<unknown>,
    TOutputSchema extends SchemaLike<unknown>,
  >(
    path: string,
    options: RouteContractOptions<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
    handler: TypedRouteHandler<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
  ): RouteBuilder<M>
  query<
    C extends ControllerConstructor,
    TParamsSchema extends SchemaLike<unknown>,
    TQuerySchema extends SchemaLike<unknown>,
    TBodySchema extends SchemaLike<unknown>,
    TOutputSchema extends SchemaLike<unknown>,
  >(
    path: string,
    options: RouteContractOptions<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
    handler: ControllerAction<C>,
  ): RouteBuilder<M>
  query(path: string, handlerOrOptions: unknown, ...rest: unknown[]): RouteBuilder<M> {
    return this.register('QUERY', path, handlerOrOptions, rest)
  }

  group(prefix: string, callback: (router: Router<M>) => void): this {
    this.prefixStack.push(prefix)
    try {
      assertSyncGroupCallback(callback(this), 'group')
    } finally {
      this.prefixStack.pop()
    }
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
      const handler = resolveHandler(route.handler, this.modelBindings, options.container, route.bindings, route.path)
      const contractMiddleware = createContractValidationMiddleware(route)
      const inlineMiddlewares = [...route.scopedMiddlewares, ...route.middlewares]
      const allMiddlewares = contractMiddleware
        ? [...resolvedMiddlewares, ...inlineMiddlewares, contractMiddleware, handler]
        : [...resolvedMiddlewares, ...inlineMiddlewares, handler]
      mountRoute(app, route.method, route.path, ...allMiddlewares)
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
    return this.registry.map(({ method, path, name, schemas, resource, openapi, routeMiddlewareNames, middlewares, scopedMiddlewares, handler, bindings }) => ({
      method,
      path,
      name,
      schemas,
      resource: serializeResourceHint(resource),
      middlewareNames: [...routeMiddlewareNames],
      // Route-local only, so a group-scoped handler does not make every route
      // in the group report middleware it never attached (`guren audit` warns
      // per route on this flag). Capabilities still see the whole chain.
      hasInlineMiddleware: middlewares.length > 0,
      capabilities: this.aggregateCapabilities(routeMiddlewareNames, [...scopedMiddlewares, ...middlewares]),
      controller: isControllerAction(handler)
        ? { name: handler[0].name, action: String(handler[1]) }
        : undefined,
      bindings: serializeBindings(path, bindings, this.modelBindings),
      ...openapi,
    }))
  }

  applyMiddlewareScope<T>(items: readonly MiddlewareScopeEntry[], callback: () => T): T {
    this.middlewareStack.push([...items])
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
  ): RouteBuilder<M> {
    if (isRouteContractOptions(handlerOrOptions)) {
      const options = handlerOrOptions as RouteContractOptions
      const [handlerOrAction] = rest

      // Contract options + controller action: validate at route level, delegate to controller
      if (isControllerAction(handlerOrAction as AnyRouteHandler)) {
        const builder = this.add(method, path, handlerOrAction as AnyControllerAction, options.middlewares ?? [])
        if (options.name) builder.name(options.name)
        const route = this.registry[this.registry.length - 1]
        applyRouteContract(route, options)
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
      applyRouteContract(route, options)
      return builder
    }

    return this.add(method, path, handlerOrOptions as AnyRouteHandler, rest as MiddlewareHandler[])
  }

  private add(method: string, path: string, handler: AnyRouteHandler, middlewares: MiddlewareHandler[] = []): RouteBuilder<M> {
    const fullPath = joinPaths(this.prefixStack, path)
    const scope = partitionMiddleware(this.middlewareStack.flat())
    const route: RegisteredRoute = {
      method,
      path: fullPath,
      handler,
      // Copied, never aliased: `RouteBuilder.middleware()` pushes here, and the
      // caller's `options.middlewares` array may be shared across routes.
      middlewares: [...middlewares],
      scopedMiddlewares: scope.handlers,
      routeMiddlewareNames: scope.names,
    }

    this.registry.push(route)
    return createRouteBuilder(route, this.namedRoutes)
  }

  /**
   * Security capabilities present on a route's middleware chain, aggregated
   * across named aliases (group-expanded) and inline handlers. Unlike
   * `resolveMiddlewareNames`, unregistered names are skipped rather than
   * thrown: `definitions()` must stay side-effect-free for introspection of
   * routers that never mount (audit, codegen), and an unresolvable alias
   * simply contributes no capabilities.
   */
  private aggregateCapabilities(
    names: string[],
    inline: MiddlewareHandler[],
    seen?: Set<string>,
    seenStamps?: Set<MiddlewareCapabilities>,
  ): MiddlewareCapabilities {
    const aggregated: MiddlewareCapabilities = {}
    const visited = seen ?? new Set<string>()
    // The same handler can legitimately appear twice in one chain — passed
    // inline as well as reached through an alias or a group. Absorbing its
    // stamp twice would read as two independent checks and degrade an 'any'
    // to 'mixed', so each stamp object contributes once. Threaded through
    // the group recursion alongside `visited`, or a stamp reached inside a
    // group would not be recognized as the one seen inline.
    const absorbed = seenStamps ?? new Set<MiddlewareCapabilities>()

    const absorb = (capabilities: MiddlewareCapabilities | undefined): void => {
      if (!capabilities || absorbed.has(capabilities)) return
      absorbed.add(capabilities)

      const auth = capabilities.authentication
      if (auth) {
        // 'required' wins: a route that both requires auth and (oddly)
        // requires guest is reported as requiring auth.
        if (!aggregated.authentication || auth.mode === 'required') {
          aggregated.authentication = auth
        }
      }

      const authz = capabilities.authorization
      if (authz) {
        const current = aggregated.authorization
        if (!current) {
          aggregated.authorization = {
            abilities: [...authz.abilities],
            mode: authz.mode,
            ...(authz.resource ? { resource: { ...authz.resource } } : {}),
          }
        } else {
          // Two checks on one chain are a conjunction. Only all-of + all-of
          // stays expressible; anything else is 'mixed' — present, but with
          // no single ability a consumer may name.
          for (const ability of authz.abilities) {
            if (!current.abilities.includes(ability)) current.abilities.push(ability)
          }
          current.mode = current.mode === 'all' && authz.mode === 'all' ? 'all' : 'mixed'
          if (authz.resource) {
            current.resource = {
              fromMethodMap: (current.resource?.fromMethodMap ?? true) && authz.resource.fromMethodMap,
            }
          }
        }
      }
    }

    for (const name of names) {
      if (visited.has(name)) continue
      visited.add(name)

      const groupNames = this.middlewareGroups.get(name)
      if (groupNames) {
        absorb(this.aggregateCapabilities(groupNames, [], visited, absorbed))
        continue
      }

      absorb(capabilitiesOf(this.middlewareAliases.get(name)))
    }

    for (const handler of inline) absorb(capabilitiesOf(handler))

    return aggregated
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

function applyRouteContract(route: RegisteredRoute, options: RouteContractOptions): void {
  route.schemas = { params: options.params, query: options.query, body: options.body, output: options.output }
  route.resource = options.resource
  route.openapi = {
    summary: options.summary,
    description: options.description,
    tags: options.tags,
    operationId: options.operationId,
    deprecated: options.deprecated,
  }
  if (options.bind) {
    route.bindings = new Map(
      Object.entries(options.bind).map(([param, binding]) => [param, normalizeModelBinding(binding)]),
    )
  }
}

class RouterMiddlewareGroupBuilder<M extends string = never> {
  constructor(
    private readonly router: Router<M>,
    private readonly items: readonly MiddlewareScopeEntry[],
  ) {}

  group(callback: (router: Router<M>) => void): Router<M> {
    return this.router.applyMiddlewareScope(this.items, () => {
      assertSyncGroupCallback(callback(this.router), 'middleware(...).group')
      return this.router
    })
  }

  get<C extends ControllerConstructor>(path: string, handler: RouteHandler<C>, ...middlewares: MiddlewareHandler[]): RouteBuilder<M>
  get<
    TParamsSchema extends SchemaLike<unknown>,
    TQuerySchema extends SchemaLike<unknown>,
    TBodySchema extends SchemaLike<unknown>,
    TOutputSchema extends SchemaLike<unknown>,
  >(
    path: string,
    options: RouteContractOptions<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
    handler: TypedRouteHandler<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
  ): RouteBuilder<M>
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
  ): RouteBuilder<M>
  get(path: string, handlerOrOptions: unknown, ...rest: unknown[]): RouteBuilder<M> {
    return this.router.applyMiddlewareScope(this.items, () => this.router.get(path, handlerOrOptions as never, ...(rest as never[])))
  }

  post<C extends ControllerConstructor>(path: string, handler: RouteHandler<C>, ...middlewares: MiddlewareHandler[]): RouteBuilder<M>
  post<
    TParamsSchema extends SchemaLike<unknown>,
    TQuerySchema extends SchemaLike<unknown>,
    TBodySchema extends SchemaLike<unknown>,
    TOutputSchema extends SchemaLike<unknown>,
  >(
    path: string,
    options: RouteContractOptions<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
    handler: TypedRouteHandler<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
  ): RouteBuilder<M>
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
  ): RouteBuilder<M>
  post(path: string, handlerOrOptions: unknown, ...rest: unknown[]): RouteBuilder<M> {
    return this.router.applyMiddlewareScope(this.items, () => this.router.post(path, handlerOrOptions as never, ...(rest as never[])))
  }

  put<C extends ControllerConstructor>(path: string, handler: RouteHandler<C>, ...middlewares: MiddlewareHandler[]): RouteBuilder<M>
  put<
    TParamsSchema extends SchemaLike<unknown>,
    TQuerySchema extends SchemaLike<unknown>,
    TBodySchema extends SchemaLike<unknown>,
    TOutputSchema extends SchemaLike<unknown>,
  >(
    path: string,
    options: RouteContractOptions<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
    handler: TypedRouteHandler<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
  ): RouteBuilder<M>
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
  ): RouteBuilder<M>
  put(path: string, handlerOrOptions: unknown, ...rest: unknown[]): RouteBuilder<M> {
    return this.router.applyMiddlewareScope(this.items, () => this.router.put(path, handlerOrOptions as never, ...(rest as never[])))
  }

  patch<C extends ControllerConstructor>(path: string, handler: RouteHandler<C>, ...middlewares: MiddlewareHandler[]): RouteBuilder<M>
  patch<
    TParamsSchema extends SchemaLike<unknown>,
    TQuerySchema extends SchemaLike<unknown>,
    TBodySchema extends SchemaLike<unknown>,
    TOutputSchema extends SchemaLike<unknown>,
  >(
    path: string,
    options: RouteContractOptions<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
    handler: TypedRouteHandler<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
  ): RouteBuilder<M>
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
  ): RouteBuilder<M>
  patch(path: string, handlerOrOptions: unknown, ...rest: unknown[]): RouteBuilder<M> {
    return this.router.applyMiddlewareScope(this.items, () => this.router.patch(path, handlerOrOptions as never, ...(rest as never[])))
  }

  delete<C extends ControllerConstructor>(path: string, handler: RouteHandler<C>, ...middlewares: MiddlewareHandler[]): RouteBuilder<M>
  delete<
    TParamsSchema extends SchemaLike<unknown>,
    TQuerySchema extends SchemaLike<unknown>,
    TBodySchema extends SchemaLike<unknown>,
    TOutputSchema extends SchemaLike<unknown>,
  >(
    path: string,
    options: RouteContractOptions<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
    handler: TypedRouteHandler<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
  ): RouteBuilder<M>
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
  ): RouteBuilder<M>
  delete(path: string, handlerOrOptions: unknown, ...rest: unknown[]): RouteBuilder<M> {
    return this.router.applyMiddlewareScope(this.items, () => this.router.delete(path, handlerOrOptions as never, ...(rest as never[])))
  }

  query<C extends ControllerConstructor>(path: string, handler: RouteHandler<C>, ...middlewares: MiddlewareHandler[]): RouteBuilder<M>
  query<
    TParamsSchema extends SchemaLike<unknown>,
    TQuerySchema extends SchemaLike<unknown>,
    TBodySchema extends SchemaLike<unknown>,
    TOutputSchema extends SchemaLike<unknown>,
  >(
    path: string,
    options: RouteContractOptions<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
    handler: TypedRouteHandler<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
  ): RouteBuilder<M>
  query<
    C extends ControllerConstructor,
    TParamsSchema extends SchemaLike<unknown>,
    TQuerySchema extends SchemaLike<unknown>,
    TBodySchema extends SchemaLike<unknown>,
    TOutputSchema extends SchemaLike<unknown>,
  >(
    path: string,
    options: RouteContractOptions<TParamsSchema, TQuerySchema, TBodySchema, TOutputSchema>,
    handler: ControllerAction<C>,
  ): RouteBuilder<M>
  query(path: string, handlerOrOptions: unknown, ...rest: unknown[]): RouteBuilder<M> {
    return this.router.applyMiddlewareScope(this.items, () => this.router.query(path, handlerOrOptions as never, ...(rest as never[])))
  }

  on<C extends ControllerConstructor>(method: string, path: string, handler: RouteHandler<C>, ...middlewares: MiddlewareHandler[]): RouteBuilder<M>
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
  ): RouteBuilder<M>
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
  ): RouteBuilder<M>
  on(method: string, path: string, handlerOrOptions: unknown, ...rest: unknown[]): RouteBuilder<M> {
    return this.router.applyMiddlewareScope(this.items, () => this.router.on(method, path, handlerOrOptions as never, ...(rest as never[])))
  }
}

function createRouteBuilder<M extends string = never>(route: RegisteredRoute, namedRoutes: Map<string, RegisteredRoute>): RouteBuilder<M> {
  return {
    name(routeName: string): RouteBuilder<M> {
      route.name = routeName
      namedRoutes.set(routeName, route)
      return this
    },
    middleware(...items: RouteMiddlewareInput<M>[]): RouteBuilder<M> {
      const { names, handlers } = partitionMiddleware(items)
      route.routeMiddlewareNames.push(...names)
      route.middlewares.push(...handlers)
      return this
    },
  }
}

// Mirrors Hono's path lexing: a param starts only at a segment boundary
// (`/status/foo:bar` is a literal), an attached regex constraint is consumed
// whole (`{[0-9]{2}}` and `{[^/]{2}}` stay intact), and a trailing `?`/`*`
// modifier belongs to the token. One pattern serves substitution and both
// binding scanners below, so the lexing rule cannot drift between them.
//
// The constraint is spelled out to one level of nesting rather than with a
// nested quantifier: every class here excludes both braces, so a scan stops
// at the next brace instead of running to the end of the string. The
// `\{[^}]*\}(?:[^/]*\})*` shape it replaces was quadratic (CodeQL
// js/polynomial-redos; measured 2.9s for a 16k-char path, vs 1.9ms here).
const PATH_PARAM_PATTERN = /(^|\/):([A-Za-z0-9_-]+\*?)(?:\{[^{}]*\{[^{}]*\}[^{}]*\}|\{[^{}]*\})?\??/gu

/** Param labels in path order, with constraints and modifiers dropped. */
function extractPathParamNames(path: string): string[] {
  return Array.from(path.matchAll(PATH_PARAM_PATTERN), (match) => match[2]!)
}

function substituteParams(path: string, params: Record<string, string | number>): string {
  return path.replace(PATH_PARAM_PATTERN, (match, prefix, key) => {
    if (!Object.prototype.hasOwnProperty.call(params, key)) {
      return match
    }

    return `${prefix}${encodeURIComponent(String(params[key]))}`
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
    const params = parseRouteSegment(options.params, ctx.req.param(), 422)
    if (params instanceof Response) {
      return params
    }

    const query = parseRouteSegment(options.query, flattenRequestQueries(ctx), 422)
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

    // A Response result carries its value as a JSON body; validate that, not the Response object.
    let outputValue: unknown = result
    let sourceBody: string | undefined
    if (result instanceof Response) {
      try {
        sourceBody = await result.clone().text()
        outputValue = JSON.parse(sourceBody)
      } catch {
        // Non-JSON response — skip output validation
        return result as RouteResult
      }
    }

    const output = options.output.safeParse(outputValue)
    if (!output.success) {
      throw new Error(
        `Route output validation failed for ${options.name ?? path}: ${JSON.stringify(formatValidationErrors(output.error))}`,
      )
    }

    // Return the parsed data so schema defaults/transforms/coercions reach the client.
    if (!(result instanceof Response)) {
      return output.data as RouteResult
    }

    return (rebuildJsonResponse(result, sourceBody as string, output.data) ?? result) as RouteResult
  }
}

/**
 * Re-serialize a JSON response from schema-parsed data, or `null` when parsing was a
 * no-op and the original response can be sent untouched.
 *
 * Headers describing the *previous* body are dropped: the parsed payload may differ
 * in byte length (schema defaults) and in content (transforms), so a copied
 * `Content-Length` or `ETag` would misdescribe what is actually sent.
 */
function rebuildJsonResponse(source: Response, sourceBody: string, data: unknown): Response | null {
  const body = JSON.stringify(data)
  if (body === sourceBody) {
    return null
  }

  const headers = new Headers(source.headers)
  dropStaleBodyHeaders(headers)
  return new Response(body, { status: source.status, headers })
}

function dropStaleBodyHeaders(headers: Headers): void {
  headers.delete('content-length')
  headers.delete('etag')
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

/**
 * Validate one request segment, throwing `ValidationException` (422) on failure.
 *
 * The controller-action path reports failures as exceptions rather than
 * responses so `ExceptionHandler` renders them: JSON for API requests, and a
 * redirect carrying the error bag for Inertia ones. `validateBody`,
 * `validateQuery` and `validateParams` on `Controller` report the same way.
 */
function throwOnInvalid(schema: ValidationSchema<unknown>, data: unknown): void {
  const result = schema.safeParse(data)
  if (!result.success) {
    throw ValidationException.withMessages(formatValidationErrors(result.error))
  }
}

function createContractValidationMiddleware(route: RegisteredRoute): MiddlewareHandler | null {
  // Only apply contract validation for controller actions with schemas
  if (!isControllerAction(route.handler)) {
    return null
  }

  const schemas = route.schemas
  if (!schemas || (!schemas.params && !schemas.query && !schemas.output)) {
    return null
  }

  return async (c, next) => {
    // Validate params and query in middleware. Body validation is left to the
    // controller's validateBody() to avoid consuming the request stream twice.
    if (schemas.params) {
      throwOnInvalid(schemas.params, c.req.param())
    }

    if (schemas.query) {
      throwOnInvalid(schemas.query, flattenRequestQueries(c))
    }

    await next()

    // Validate output schema against the response body
    if (schemas.output && c.res) {
      let sourceBody: string
      let parsedBody: unknown
      try {
        sourceBody = await c.res.clone().text()
        parsedBody = JSON.parse(sourceBody)
      } catch {
        // Non-JSON response or parse error — skip output validation
        return
      }

      const parsed = schemas.output.safeParse(parsedBody)
      if (!parsed.success) {
        const errors = 'flatten' in parsed.error && typeof (parsed.error as any).flatten === 'function'
          ? (parsed.error as any).flatten()
          : parsed.error
        c.res = c.json({ message: 'Response validation failed', errors }, 500)
        return
      }

      // Rebuild the response from the parsed data so defaults/transforms/coercions
      // applied by the schema reach the client.
      const rebuilt = rebuildJsonResponse(c.res, sourceBody, parsed.data)
      if (rebuilt) {
        c.res = rebuilt
        // Hono's `c.res` setter copies every header off the replaced response, which
        // restores the ones rebuildJsonResponse just dropped — drop them again.
        dropStaleBodyHeaders(c.res.headers)
      }
    }
  }
}

function resolveHandler(
  action: AnyRouteHandler,
  modelBindings: Map<string, RegisteredBinding>,
  container?: Container,
  routeBindings?: Map<string, ModelBinding>,
  path?: string,
): MiddlewareHandler {
  if (isControllerAction(action)) {
    const [ControllerClass, methodName] = action
    return async (c) => {
      const inject = ControllerClass.inject
      let controller: Controller

      if (inject && inject.length > 0 && container) {
        const deps = inject.map((key) => container.make(key))
        controller = new ControllerClass(...deps)
      } else {
        controller = new ControllerClass()
      }

      controller.setContext(c)
      if (container) {
        controller.setContainer(container)
      }

      // Resolve per-route model bindings (from RouteContractOptions.bind).
      // The model classes they claim are remembered: `this.model()` is keyed
      // by class, so a router-level bind() must not overwrite a record the
      // route asked for by name.
      const routeBoundModels = new Set<unknown>()
      if (routeBindings && routeBindings.size > 0) {
        const params = c.req.param() as Record<string, string>
        for (const [paramName, binding] of routeBindings) {
          const value = params[paramName]
          if (value !== undefined) {
            controller.setResolvedModel(binding.model, await resolveModelBinding(binding, value))
            routeBoundModels.add(binding.model)
          }
        }
      }

      const method = controller[methodName]
      if (typeof method !== 'function') {
        throw new Error(`Controller method ${String(methodName)} is not defined on ${ControllerClass.name}.`)
      }

      // Router-level bindings (bind(param, ...)) travel as positional
      // arguments after the context, in path-parameter order; the ones bound
      // to a model are also exposed through `this.model(Model)`.
      const resolvedBindings = modelBindings.size > 0
        ? await resolveModelBindings(c, modelBindings, path)
        : []
      const args: unknown[] = [c]
      for (const { model, value } of resolvedBindings) {
        if (model && !routeBoundModels.has(model)) controller.setResolvedModel(model, value)
        args.push(value)
      }

      const result = await (method as (...a: unknown[]) => unknown).apply(controller, args)
      return ensureResponse(result, c)
    }
  }

  return async (c, next) => {
    const result = await action(c, next)
    // Middleware mounted as a handler may set the response via c.res
    // (directly or through next()) and return nothing — honor it instead
    // of synthesizing a 204.
    if (result === undefined && c.finalized) {
      return c.res
    }
    return ensureResponse(result, c)
  }
}

async function resolveModelBindings(
  c: Context,
  modelBindings: Map<string, RegisteredBinding>,
  path?: string,
): Promise<Array<{ model?: BindableModel; value: unknown }>> {
  if (modelBindings.size === 0) {
    return []
  }

  const resolved: Array<{ model?: BindableModel; value: unknown }> = []
  const params = c.req.param()

  // Get path params in order from the route pattern
  const pathParams = path ? extractPathParamNames(path) : []

  for (const param of pathParams) {
    const binding = modelBindings.get(param)
    if (!binding) continue
    const value = params[param]
    if (value !== undefined) {
      resolved.push({ model: binding.model, value: await binding.resolve(value) })
    }
  }

  return resolved
}

function ensureResponse(result: unknown, c?: Context): Response {
  const response = buildResponse(result)

  // Handlers and controllers return raw Response objects, which bypass
  // Hono's response construction — headers staged via c.header() in
  // upstream middleware would be silently dropped. Rebuild through
  // c.newResponse() so prepared headers are merged (Set-Cookie appended,
  // the handler's own headers winning otherwise).
  if (c) {
    return c.newResponse(response.body, response) as Response
  }

  return response
}

function buildResponse(result: unknown): Response {
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

/**
 * Introspectable model bindings for a route: per-route `bind` entries plus
 * router-level `bind(param, Model)` calls whose param appears in the path
 * (route-level entries win). Bindings without a usable constructor name
 * (anonymous classes, custom resolvers) are omitted rather than emitted
 * as an empty string.
 */
function serializeBindings(
  path: string,
  routeBindings: Map<string, ModelBinding> | undefined,
  routerBindings: Map<string, RegisteredBinding>,
): Record<string, string> | undefined {
  const entries = new Map<string, string>()

  for (const param of extractPathParamNames(path)) {
    const name = routerBindings.get(param)?.model?.name
    if (name) entries.set(param, name)
  }

  for (const [param, { model }] of routeBindings ?? []) {
    if (model.name) entries.set(param, model.name)
  }

  return entries.size > 0 ? Object.fromEntries(entries) : undefined
}

/**
 * Serializes a {@link ResourceResponseHint} for introspection, replacing each
 * Resource class with its constructor name. All-or-nothing on purpose: a
 * class without a usable name (an anonymous class expression) voids the whole
 * hint rather than narrowing it, because a response type missing one of its
 * keys describes a payload the server never sends.
 */
function serializeResourceHint(hint: ResourceResponseHint | undefined): ResourceResponseShape | undefined {
  if (hint === undefined) {
    return undefined
  }

  if (typeof hint === 'function') {
    return hint.name || undefined
  }

  // Array.isArray does not narrow the readonly tuple member of the union
  // (it is not assignable to `any[]`), so without the assertion the tuple
  // would fall through to the Object.entries path and serialize as
  // `{ '0': ... }`.
  if (Array.isArray(hint)) {
    const inner = serializeResourceHint((hint as readonly ResourceResponseHint[])[0])
    return inner === undefined ? undefined : [inner]
  }

  const entries: Array<[string, ResourceResponseShape]> = []
  for (const [key, value] of Object.entries(hint)) {
    const serialized = serializeResourceHint(value as ResourceResponseHint)
    if (serialized === undefined) return undefined
    entries.push([key, serialized])
  }
  // Object.fromEntries defines own properties, so a `__proto__` envelope key
  // lands as data instead of invoking the prototype setter and vanishing.
  return Object.fromEntries(entries)
}

function isControllerAction(action: AnyRouteHandler): action is AnyControllerAction {
  return Array.isArray(action)
}

function isRouteContractOptions(value: unknown): value is RouteContractOptions<SchemaLike<unknown>, SchemaLike<unknown>, SchemaLike<unknown>, SchemaLike<unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  return 'params' in value
    || 'query' in value
    || 'body' in value
    || 'output' in value
    || 'resource' in value
    || 'bind' in value
    || 'name' in value
    || 'middlewares' in value
    || 'summary' in value
    || 'description' in value
    || 'tags' in value
    || 'operationId' in value
    || 'deprecated' in value
}

function joinPaths(prefixStack: string[], path: string): string {
  const segments = [...prefixStack, path]
    .filter(Boolean)
    .map(trimSlashes)
    .filter(Boolean)

  if (segments.length === 0) {
    return '/'
  }

  const combined = segments.join('/')
  return '/' + combined.replace(/\/+/gu, '/')
}
