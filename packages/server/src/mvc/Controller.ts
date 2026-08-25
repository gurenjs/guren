import type { Context } from 'hono'
import { createElement, type FC } from 'hono/jsx'
import { inertia, type InertiaOptions } from './inertia/InertiaEngine'
import { resolveSharedInertiaProps, type ResolvedSharedInertiaProps } from './inertia/shared'
import { AUTH_CONTEXT_KEY } from '../http/middleware/auth'
import { getRequestLocale, getRequestTranslator, type TranslatorBinding } from '../http/middleware/detect-locale'
import { tryGetI18n, type I18nManager, type RegisteredTranslationKey, type ReplacementValues } from '../i18n'
import { flattenRequestQueries, parseRequestPayload } from '../http/request'
import type { AuthContext } from '../auth/types'
import type { ServiceBindings } from '../container/bindings'
import type { ContainerLike } from '../container/types'
import { ValidationException } from '../errors/exceptions/ValidationException'
import { getApiTokenOrFail } from '../auth/api-token'
import { getGate } from '../authorization/Gate'
import type { AuthUser } from '../authorization/types'

/**
 * Duck-type interface for Zod-like schemas.
 * Allows validation without a direct Zod dependency.
 */
interface ZodLikeSchema<T> {
  safeParse(data: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } }
}

/**
 * Result type for safe validation methods (discriminated union).
 */
export type SafeValidationResult<T> =
  | { success: true; data: T }
  | { success: false; errors: Record<string, string> }

/**
 * The record `Controller.model()` returns for a bound model class. ORM models
 * carry their row type as a `recordType` marker (set by `defineModel()`);
 * `findOrFail`'s own return type cannot be read off the class because the
 * method is generic in `this`, and `ReturnType` widens it to the base row.
 * Anything without a usable marker — a class extending `Model` directly
 * without redeclaring it, or a plain `{ findOrFail }` adapter — falls back to
 * whatever its `findOrFail` resolves to. The marker is only trusted when it
 * names an object type: `Model`'s own is `unknown`, and an unrelated
 * `recordType` on some adapter (a string tag, say) describes no record.
 */
export type BoundModelRecord<T extends { findOrFail(...args: any[]): Promise<any> }> =
  T extends { readonly recordType: infer R }
    ? unknown extends R
      ? Awaited<ReturnType<T['findOrFail']>>
      : R extends object ? R : Awaited<ReturnType<T['findOrFail']>>
    : Awaited<ReturnType<T['findOrFail']>>

type DefaultInertiaProps = Record<string, unknown>

export type AuthPayload = Record<string, unknown> & { user: unknown }

export type InertiaPageContractLike<
  Component extends string = string,
  Props extends DefaultInertiaProps = DefaultInertiaProps,
> = {
  id: Component
  component?: Component
  __props?: Props
}

type InertiaResponseMarker<Component extends string, Props extends DefaultInertiaProps> = {
  __gurenInertia: {
    component: Component
    props: Props
  }
}

export type InertiaResponse<Component extends string, Props extends DefaultInertiaProps> = Response &
  InertiaResponseMarker<Component, Props>

type InertiaWithProps = { __gurenInertia: { props: DefaultInertiaProps } }

type ExtractInertiaProps<T> = Awaited<T> extends infer R
  ? R extends InertiaWithProps
    ? R['__gurenInertia']['props']
    : never
  : never

export type InferInertiaProps<T> = [ExtractInertiaProps<T>] extends [never] ? DefaultInertiaProps : ExtractInertiaProps<T>

export type ControllerInertiaProps<TController extends Controller, TAction extends keyof TController> = TController[TAction] extends (
  ...args: any[]
) => infer TResult
  ? InferInertiaProps<Awaited<TResult>>
  : DefaultInertiaProps

export interface RedirectOptions {
  status?: number
  headers?: HeadersInit
}

/** Options for {@link Controller.view} (RFC 0014). */
export interface ViewOptions {
  status?: number
  headers?: HeadersInit
  /**
   * Prepend `<!doctype html>` and require a full document (an `<html>` root).
   * Pass `false` for an intentional fragment response — no doctype, no check.
   */
  doctype?: boolean
}

type InertiaResponseOptions = Omit<InertiaOptions, 'url' | 'request'> & { url?: string }

type InertiaPageComponent<TPage extends InertiaPageContractLike> = TPage['id']
type InertiaPageProps<TPage extends InertiaPageContractLike> = NonNullable<TPage['__props']>

/**
 * Constructor type for controllers with optional DI.
 */
export type ControllerConstructorWithInject = {
  new (...args: any[]): Controller
  inject?: readonly string[]
}

/**
 * Base controller inspired by Laravel's expressive API. Subclasses can access
 * the current Hono context through the protected `ctx` getter and rely on the
 * helper response builders for common patterns.
 *
 * Supports dependency injection via the `static inject` convention:
 * ```typescript
 * class PostController extends Controller {
 *   static inject = ['cache', 'events'] as const
 *   constructor(private cache: CacheManager, private events: EventManager) { super() }
 * }
 * ```
 */
export class Controller {
  /**
   * Dependencies to inject from the container.
   * Override in subclasses to declare required services.
   */
  static inject?: readonly string[]

  private context?: Context
  private parsedBody?: Record<string, unknown>
  private resolvedModels?: Map<unknown, unknown>
  private _container?: ContainerLike

  setContext(context: Context): void {
    this.context = context
  }

  /** @internal Called by the router to inject the DI container. */
  setContainer(container: ContainerLike): void {
    this._container = container
  }

  /**
   * Store a resolved model instance from route model binding.
   * @internal Called by the router, not intended for direct use.
   */
  setResolvedModel(modelClass: unknown, instance: unknown): void {
    if (!this.resolvedModels) this.resolvedModels = new Map()
    this.resolvedModels.set(modelClass, instance)
  }

  /**
   * Retrieve a model instance resolved via route model binding — a per-route
   * `bind` option or a router-level `router.bind(param, Model)`. Look up by
   * primary key with the class alone, or by another column with a
   * `[Model, column]` tuple.
   *
   * @example
   * ```typescript
   * // routes/web.ts
   * posts.get('/:id', { bind: { id: Post }, name: 'posts.show' }, [PostController, 'show'])
   * posts.get('/by-slug/:slug', { bind: { slug: [Post, 'slug'] } }, [PostController, 'show'])
   *
   * // PostController.ts
   * async show() {
   *   const post = this.model(Post)  // typed as PostRecord
   *   return this.inertia(pages.posts.Show, { post })
   * }
   * ```
   */
  protected model<T extends { findOrFail(...args: any[]): Promise<any> }>(
    modelClass: T,
  ): BoundModelRecord<T> {
    const instance = this.resolvedModels?.get(modelClass)
    if (instance === undefined) {
      throw new Error(
        `No model binding found for ${(modelClass as { name?: string }).name ?? 'unknown'}. ` +
        'Ensure the route has a matching bind option in RouteContractOptions, or the router a bind(param, Model) call.',
      )
    }
    return instance as BoundModelRecord<T>
  }

  protected get ctx(): Context {
    if (!this.context) {
      throw new Error('Controller context has not been set.')
    }

    return this.context
  }

  protected get request() {
    return this.ctx.req
  }

  /**
   * Get an uploaded file from a multipart request.
   *
   * Returns null when the field is missing, is not a file, or the upload is
   * empty. Hono caches the parsed body, so this composes with other body
   * reads in the same request.
   *
   * @example
   * ```typescript
   * const avatar = await this.file('avatar')
   * if (!avatar) {
   *   throw ValidationException.withMessages({ avatar: 'Choose a file.' })
   * }
   * await storage.disk().put(`avatars/${avatar.name}`, Buffer.from(await avatar.arrayBuffer()))
   * ```
   */
  protected async file(name: string): Promise<File | null> {
    const body = await this.ctx.req.parseBody({ all: true })
    const value = body[name]
    const candidate = Array.isArray(value) ? value[0] : value
    return candidate instanceof File && candidate.size > 0 ? candidate : null
  }

  /**
   * Get all uploaded files for a multipart field (e.g. `<input multiple>`).
   * Returns an empty array when none were uploaded.
   */
  protected async files(name: string): Promise<File[]> {
    const body = await this.ctx.req.parseBody({ all: true })
    const value = body[name]
    const values = Array.isArray(value) ? value : value !== undefined ? [value] : []
    return values.filter((item): item is File => item instanceof File && item.size > 0)
  }

  protected get auth(): AuthContext {
    const auth = this.ctx.get(AUTH_CONTEXT_KEY) as AuthContext | undefined
    if (!auth) {
      throw new Error('Controller auth helper requires the auth middleware. Make sure AuthServiceProvider is registered.')
    }

    return auth
  }

  protected make<K extends keyof ServiceBindings>(key: K): ServiceBindings[K]
  protected make<T>(key: string): T
  protected make(key: string): unknown {
    if (!this._container) {
      throw new Error('Controller.make() requires a DI container. Ensure the app is booted with a Container.')
    }
    return this._container.make(key)
  }

  // ─── API Token Helpers ─────────────────────────────────────────

  /**
   * Get the authenticated API token or throw AuthenticationException.
   *
   * @example
   * ```typescript
   * const { userId, abilities } = this.apiToken()
   * ```
   */
  protected apiToken() {
    return getApiTokenOrFail(this.ctx)
  }

  /**
   * Get the authenticated user ID from the API token.
   *
   * @example
   * ```typescript
   * const userId = this.apiTokenUserId()
   * ```
   */
  protected apiTokenUserId(): string | number {
    return this.apiToken().userId
  }

  // ─── Authorization Helpers ──────────────────────────────────────

  /**
   * Authorize the current user (or guest) for an ability.
   * Throws AuthorizationException (403) when denied.
   *
   * ORM records are plain objects with no constructor information, so pass
   * the model class alongside the record to resolve the policy:
   *
   * @example
   * ```typescript
   * const post = await Post.findOrFail(id)
   * await this.authorize('update', [Post, post])
   * await this.authorize('create', Post)
   * ```
   */
  protected async authorize(ability: string, ...args: unknown[]): Promise<void> {
    await getGate().forUser(await this.gateUser()).authorize(ability, ...args)
  }

  /**
   * Check whether the current user (or guest) can perform an ability.
   *
   * @example
   * ```typescript
   * if (await this.can('update', [Post, post])) { ... }
   * ```
   */
  protected async can(ability: string, ...args: unknown[]): Promise<boolean> {
    return getGate().forUser(await this.gateUser()).allows(ability, ...args)
  }

  private async gateUser(): Promise<AuthUser | null> {
    const auth = this.ctx.get(AUTH_CONTEXT_KEY) as AuthContext | undefined
    if (!auth) {
      return null
    }
    return (await auth.user()) as AuthUser | null
  }

  // ─── Response Helpers ───────────────────────────────────────────

  /**
   * Render a `hono/jsx` component to a plain server-rendered HTML response —
   * the non-hydrating counterpart to {@link inertia} for public content pages
   * (RFC 0014). Takes the component and its props separately so controllers
   * stay plain `.ts` and the props are type-checked at the call site.
   *
   * @example
   * ```typescript
   * async show() {
   *   const post = await Post.findOrFail(id)
   *   return this.view(PostPage, { post })
   * }
   * ```
   */
  protected async view<P>(component: FC<P>, props: P, options: ViewOptions = {}): Promise<Response> {
    // Build a real hono element and let hono reduce it. Invoking the
    // component directly and reducing the result by hand looks equivalent
    // and is not: it skips hono's escaping of raw strings inside a `Child[]`
    // (a stored-XSS hole caught in the RFC 0014 review).
    const body = String(await createElement(component as never, props as never).toString())

    if (options.doctype !== false && !/^\s*<html[\s>]/iu.test(body)) {
      const name = component.displayName ?? (component as { name?: string }).name ?? 'component'
      throw new Error(
        `view(): ${name} rendered a fragment, not a document. ` +
          'Wrap the page in your Layout (an <html> root), or pass { doctype: false } ' +
          'for an intentional fragment response. Without <html>/<head>, <title> and ' +
          '<meta> tags are not hoisted and the page ships unstyled.',
      )
    }

    const headers = new Headers(options.headers)
    if (!headers.has('content-type')) {
      headers.set('content-type', 'text/html; charset=utf-8')
    }

    return new Response((options.doctype === false ? '' : '<!doctype html>') + body, {
      status: options.status ?? 200,
      headers,
    })
  }

  protected async inertia<TPage extends InertiaPageContractLike>(
    page: TPage,
    props: InertiaPageProps<TPage>,
    options?: InertiaResponseOptions,
  ): Promise<InertiaResponse<InertiaPageComponent<TPage>, InertiaPageProps<TPage> & ResolvedSharedInertiaProps>>
  protected async inertia<Component extends string, Props extends DefaultInertiaProps>(
    component: Component,
    props: Props,
    options?: InertiaResponseOptions,
  ): Promise<InertiaResponse<Component, Props & ResolvedSharedInertiaProps>>
  protected async inertia<Component extends string, Props extends DefaultInertiaProps>(
    componentOrPage: Component | InertiaPageContractLike<Component, Props>,
    props: Props,
    options: InertiaResponseOptions = {},
  ): Promise<InertiaResponse<Component, Props & ResolvedSharedInertiaProps>> {
    const ctx = this.ctx
    const component =
      typeof componentOrPage === 'string'
        ? componentOrPage
        : componentOrPage.component ?? componentOrPage.id

    const sharedProps = await resolveSharedInertiaProps(ctx, this._container)
    const propsWithShared = { ...sharedProps, ...props } as Props & ResolvedSharedInertiaProps

    // The engine derives the page url (path + query string) from the request
    // when options.url is absent.
    const response = await inertia(component, propsWithShared as Record<string, unknown>, {
      ...options,
      // No 'en' fallback here (unlike the locale getter): unconfigured apps
      // keep the Inertia engine's own default lang.
      lang: options.lang ?? this.#resolveLocale(),
      request: ctx.req.raw,
    })

    ;(response as InertiaResponse<Component, typeof propsWithShared>).__gurenInertia = {
      component,
      props: propsWithShared,
    }

    return response as InertiaResponse<Component, typeof propsWithShared>
  }

  /**
   * Locale resolved for the current request: the request-scoped `locale`
   * context variable (set by locale middleware) wins over the app-wide i18n
   * locale (the router-injected container binding, then the `setI18n()`
   * global). Falls back to `'en'` when no i18n is configured.
   */
  protected get locale(): string {
    return this.#resolveLocale() ?? 'en'
  }

  /**
   * Translate a key for the current request locale.
   *
   * Uses the request-scoped translator bound by the locale detection
   * middleware when present, falling back to a translator scoped to
   * `this.locale` from the container's `i18n` binding (then the `setI18n()`
   * global).
   *
   * @example
   * ```typescript
   * this.t('posts.created')
   * this.t('posts.greeting', { name: user.name })
   * ```
   */
  protected t(key: RegisteredTranslationKey, replacements?: ReplacementValues): string {
    return this.#requestTranslator().t(key, replacements)
  }

  /**
   * Translate a key with a count for pluralization, using the same locale
   * resolution as {@link Controller.t}.
   */
  protected tc(key: RegisteredTranslationKey, count: number, replacements?: ReplacementValues): string {
    return this.#requestTranslator().tc(key, count, replacements)
  }

  #requestTranslator(): TranslatorBinding {
    const bound = getRequestTranslator(this.ctx)
    if (bound) {
      return bound
    }

    const i18n = this.#resolveI18n()
    if (!i18n) {
      throw new Error(
        'Controller i18n helpers require i18n to be configured. Pass createApp({ i18n }) or register an I18nManager.',
      )
    }

    const locale = getRequestLocale(this.ctx)
    return locale && locale !== i18n.getLocale() ? i18n.forLocale(locale) : i18n
  }

  #resolveLocale(): string | undefined {
    const requestLocale = getRequestLocale(this.ctx)
    if (requestLocale) {
      return requestLocale
    }

    const locale = this.#resolveI18n()?.getLocale()
    return typeof locale === 'string' && locale.length > 0 ? locale : undefined
  }

  #resolveI18n(): I18nManager | undefined {
    if (this._container?.has?.('i18n')) {
      return this._container.make('i18n') as I18nManager
    }

    return tryGetI18n()
  }

  protected json<T>(data: T, init: ResponseInit = {}): Response {
    return new Response(JSON.stringify(data), {
      ...init,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        ...init.headers,
      },
    })
  }

  protected text(body: string, init: ResponseInit = {}): Response {
    return new Response(body, {
      ...init,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        ...init.headers,
      },
    })
  }

  protected redirect(url: string, options: RedirectOptions = {}): Response {
    const requestMethod = this.request.method?.toUpperCase?.()
    const defaultStatus = requestMethod && requestMethod !== 'GET' ? 303 : 302
    const { status = defaultStatus, headers } = options
    return new Response(null, {
      status,
      headers: {
        Location: url,
        ...headers,
      },
    })
  }

  /**
   * Return a 204 No Content response.
   */
  protected noContent(): Response {
    return new Response(null, { status: 204 })
  }

  /**
   * Return a 201 Created response with JSON data.
   */
  protected created<T>(data?: T, init: ResponseInit = {}): Response {
    return this.jsonStatus(201, data, init)
  }

  /**
   * Return a 202 Accepted response with optional JSON data.
   */
  protected accepted<T>(data?: T, init: ResponseInit = {}): Response {
    return this.jsonStatus(202, data, init)
  }

  private jsonStatus<T>(status: number, data?: T, init: ResponseInit = {}): Response {
    if (data === undefined) {
      return new Response(null, { status, ...init })
    }
    return new Response(JSON.stringify(data), {
      status,
      ...init,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        ...init.headers,
      },
    })
  }

  // ─── Input Helpers ──────────────────────────────────────────────

  /**
   * Get a specific input value from the request body or query parameters.
   * Body values take precedence over query parameters.
   */
  protected async input<T = unknown>(key: string, defaultValue?: T): Promise<T | undefined> {
    const body = await this.getBody()
    if (key in body) {
      return body[key] as T
    }
    const queryValue = this.ctx.req.query(key)
    if (queryValue !== undefined) {
      return queryValue as T
    }
    return defaultValue
  }

  /**
   * Get a query parameter value.
   */
  protected query(key: string, defaultValue?: string): string | undefined {
    return this.ctx.req.query(key) ?? defaultValue
  }

  /**
   * Get only the specified keys from the request body.
   */
  protected async only(...keys: string[]): Promise<Record<string, unknown>> {
    const body = await this.getBody()
    const result: Record<string, unknown> = {}
    for (const key of keys) {
      if (key in body) {
        result[key] = body[key]
      }
    }
    return result
  }

  /**
   * Get all request body values except the specified keys.
   */
  protected async except(...keys: string[]): Promise<Record<string, unknown>> {
    const body = await this.getBody()
    const excluded = new Set(keys)
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(body)) {
      if (!excluded.has(key)) {
        result[key] = value
      }
    }
    return result
  }

  /**
   * Check if a key exists in the request body.
   */
  protected async has(key: string): Promise<boolean> {
    const body = await this.getBody()
    return key in body
  }

  /** Flatten query string arrays to scalar values for cleaner schema usage. */
  private flattenQueries(): Record<string, unknown> {
    return flattenRequestQueries(this.ctx)
  }

  // ─── Validation ─────────────────────────────────────────────────

  /**
   * Validate the request body against a Zod-like schema.
   * Throws ValidationException on failure.
   *
   * @example
   * ```typescript
   * const data = await this.validateBody(CreatePostSchema)
   * ```
   */
  protected async validateBody<T>(schema: ZodLikeSchema<T>): Promise<T> {
    const body = await this.getBody()
    return this.runValidation(schema, body)
  }

  /**
   * Validate query parameters against a Zod-like schema.
   * Throws ValidationException on failure.
   *
   * @example
   * ```typescript
   * const { page } = this.validateQuery(PageQuerySchema)
   * ```
   */
  protected validateQuery<T>(schema: ZodLikeSchema<T>): T {
    return this.runValidation(schema, this.flattenQueries())
  }

  /**
   * Validate route parameters against a Zod-like schema.
   * Throws ValidationException on failure.
   *
   * @example
   * ```typescript
   * const { id } = this.validateParams(PostIdParamSchema)
   * ```
   */
  protected validateParams<T>(schema: ZodLikeSchema<T>): T {
    const params = this.ctx.req.param() as Record<string, string>
    return this.runValidation(schema, params)
  }

  // ─── Safe Validation (no-throw) ──────────────────────────────

  /**
   * Validate the request body against a Zod-like schema without throwing.
   * Returns a discriminated union: `{ success: true, data }` or `{ success: false, errors }`.
   *
   * @example
   * ```typescript
   * const result = await this.validateBodySafe(CreatePostSchema)
   * if (!result.success) {
   *   return this.inertia(pages.posts.New, { errors: result.errors }, { status: 422 })
   * }
   * const { title, body } = result.data
   * ```
   */
  protected async validateBodySafe<T>(schema: ZodLikeSchema<T>): Promise<SafeValidationResult<T>> {
    const body = await this.getBody()
    return this.runValidationSafe(schema, body)
  }

  /**
   * Validate query parameters against a Zod-like schema without throwing.
   * Returns a discriminated union: `{ success: true, data }` or `{ success: false, errors }`.
   */
  protected validateQuerySafe<T>(schema: ZodLikeSchema<T>): SafeValidationResult<T> {
    return this.runValidationSafe(schema, this.flattenQueries())
  }

  /**
   * Validate route parameters against a Zod-like schema without throwing.
   * Returns a discriminated union: `{ success: true, data }` or `{ success: false, errors }`.
   */
  protected validateParamsSafe<T>(schema: ZodLikeSchema<T>): SafeValidationResult<T> {
    const params = this.ctx.req.param() as Record<string, string>
    return this.runValidationSafe(schema, params)
  }

  private runValidation<T>(schema: ZodLikeSchema<T>, data: unknown): T {
    const result = schema.safeParse(data)
    if (result.success) {
      return result.data
    }
    throw ValidationException.fromZodError(result.error)
  }

  private runValidationSafe<T>(schema: ZodLikeSchema<T>, data: unknown): SafeValidationResult<T> {
    const result = schema.safeParse(data)
    if (result.success) {
      return { success: true, data: result.data }
    }
    const errors: Record<string, string> = {}
    for (const issue of result.error.issues) {
      const field = issue.path.join('.') || issue.message
      if (!errors[field]) {
        errors[field] = issue.message
      }
    }
    return { success: false, errors }
  }

  // ─── Private Helpers ────────────────────────────────────────────

  private async getBody(): Promise<Record<string, unknown>> {
    if (this.parsedBody) {
      return this.parsedBody
    }

    try {
      this.parsedBody = await parseRequestPayload(this.ctx)
    } catch {
      this.parsedBody = {}
    }

    return this.parsedBody
  }
}
