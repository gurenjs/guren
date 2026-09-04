import type { Context } from 'hono'
import type { FC } from 'hono/jsx'
import { renderDocument, type ViewOptions } from './view'
import { inertia, type InertiaOptions } from './inertia/InertiaEngine'
import { resolveSharedInertiaProps, type ResolvedSharedInertiaProps } from './inertia/shared'
import { getRequestLocale, getRequestTranslator, type TranslatorBinding } from '../http/middleware/detect-locale'
import { tryGetI18n, type I18nManager, type RegisteredTranslationKey, type ReplacementValues } from '../i18n'
import { asRecord, flattenRequestQueries, parseRequestBody, parseRequestUploads } from '../http/request'
import { getAuthContext } from '../auth/context'
import type { AuthContext } from '../auth/types'
import type { ServiceBindings } from '../container/bindings'
import type { ContainerLike } from '../container/types'
import { ValidationException } from '../errors/exceptions/ValidationException'
import { getApiTokenOrFail } from '../auth/api-token'
import { getGate } from '../authorization/Gate'
import type { AuthUser } from '../authorization/types'

/** Duck-typed Zod-like schema, so validation needs no direct Zod dependency. */
interface ZodLikeSchema<T> {
  safeParse(data: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } }
}

/** Result type for safe validation methods (discriminated union). */
export type SafeValidationResult<T> =
  | { success: true; data: T }
  | { success: false; errors: Record<string, string> }

/**
 * The record `Controller.model()` returns. ORM models carry their row type as a
 * `recordType` marker (set by `defineModel()`); `findOrFail`'s return type cannot
 * stand in because it is generic in `this` and `ReturnType` widens it to the base
 * row. The marker is trusted only when it names an object type.
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

type InertiaResponseOptions = Omit<InertiaOptions, 'url' | 'request'> & { url?: string }

type InertiaPageComponent<TPage extends InertiaPageContractLike> = TPage['id']
type InertiaPageProps<TPage extends InertiaPageContractLike> = NonNullable<TPage['__props']>

/** Constructor type for controllers with optional DI. */
export type ControllerConstructorWithInject = {
  new (...args: any[]): Controller
  inject?: readonly string[]
}

/**
 * Base controller inspired by Laravel's expressive API. Subclasses reach the
 * Hono context through the protected `ctx` getter. Dependencies are declared
 * with `static inject = ['cache'] as const` and passed to the constructor.
 */
export class Controller {
  /** Services to resolve from the container and pass to the constructor. */
  static inject?: readonly string[]

  private context?: Context
  private parsedBody?: { value: unknown }
  private resolvedModels?: Map<unknown, unknown>
  private _container?: ContainerLike

  setContext(context: Context): void {
    this.context = context
  }

  /** @internal Called by the router to inject the DI container. */
  setContainer(container: ContainerLike): void {
    this._container = container
  }

  /** @internal Called by the router to store a route-bound model instance. */
  setResolvedModel(modelClass: unknown, instance: unknown): void {
    if (!this.resolvedModels) this.resolvedModels = new Map()
    this.resolvedModels.set(modelClass, instance)
  }

  /**
   * Retrieve a model instance resolved via route model binding — a per-route
   * `bind` option or a router-level `router.bind(param, Model)`. The class
   * alone looks up by primary key, a `[Model, column]` tuple by that column.
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
   * Get an uploaded file from a multipart request. Returns null when the field
   * is missing, is not a file, or the upload is empty. Hono caches the parsed
   * body, so this composes with other body reads in the same request.
   */
  protected async file(name: string): Promise<File | null> {
    const body = await parseRequestUploads(this.ctx)
    const value = body[name]
    const candidate = Array.isArray(value) ? value[0] : value
    return candidate instanceof File && candidate.size > 0 ? candidate : null
  }

  /**
   * Get all uploaded files for a multipart field (e.g. `<input multiple>`).
   * Returns an empty array when none were uploaded.
   */
  protected async files(name: string): Promise<File[]> {
    const body = await parseRequestUploads(this.ctx)
    const value = body[name]
    const values = Array.isArray(value) ? value : value !== undefined ? [value] : []
    return values.filter((item): item is File => item instanceof File && item.size > 0)
  }

  protected get auth(): AuthContext {
    const auth = getAuthContext(this.ctx)
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

  /** Get the authenticated API token, or throw AuthenticationException. */
  protected apiToken() {
    return getApiTokenOrFail(this.ctx)
  }

  /** Get the authenticated user ID from the API token. */
  protected apiTokenUserId(): string | number {
    return this.apiToken().userId
  }

  /**
   * Authorize the current user (or guest) for an ability; throws
   * AuthorizationException (403) when denied. ORM records are plain objects
   * with no constructor information, so pass the model class alongside the
   * record: `await this.authorize('update', [Post, post])`.
   */
  protected async authorize(ability: string, ...args: unknown[]): Promise<void> {
    await getGate().forUser(await this.gateUser()).authorize(ability, ...args)
  }

  /** Check an ability without throwing: `await this.can('update', [Post, post])`. */
  protected async can(ability: string, ...args: unknown[]): Promise<boolean> {
    return getGate().forUser(await this.gateUser()).allows(ability, ...args)
  }

  private async gateUser(): Promise<AuthUser | null> {
    const auth = getAuthContext(this.ctx)
    if (!auth) {
      return null
    }
    return (await auth.user()) as AuthUser | null
  }

  /**
   * Render a `hono/jsx` component to a plain server-rendered HTML response —
   * the non-hydrating counterpart to {@link inertia} (RFC 0014). Escaping
   * covers markup only, not URL schemes: a `javascript:` href built from user
   * data is emitted verbatim, so sanitize user-supplied URLs upstream.
   */
  protected view<P>(component: FC<P>, props: P, options?: ViewOptions): Promise<Response> {
    return renderDocument(component, props, options)
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
   * Locale for the current request: the request-scoped `locale` context
   * variable wins over the app-wide i18n locale. Falls back to `'en'`.
   */
  protected get locale(): string {
    return this.#resolveLocale() ?? 'en'
  }

  /**
   * Translate a key for the current request locale, using the request-scoped
   * translator the locale middleware bound, else one scoped to `this.locale`.
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

  protected noContent(): Response {
    return new Response(null, { status: 204 })
  }

  protected created<T>(data?: T, init: ResponseInit = {}): Response {
    return this.jsonStatus(201, data, init)
  }

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

  /** Get an input value; body values take precedence over query parameters. */
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

  protected query(key: string, defaultValue?: string): string | undefined {
    return this.ctx.req.query(key) ?? defaultValue
  }

  /** Get only the specified keys from the request body. */
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

  /** Get all request body values except the specified keys. */
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

  /** Check if a key exists in the request body. */
  protected async has(key: string): Promise<boolean> {
    const body = await this.getBody()
    return key in body
  }

  /** Flatten query string arrays to scalar values for cleaner schema usage. */
  private flattenQueries(): Record<string, unknown> {
    return flattenRequestQueries(this.ctx)
  }

  /** Validate the request body; throws ValidationException on failure. */
  protected async validateBody<T>(schema: ZodLikeSchema<T>): Promise<T> {
    return this.runValidation(schema, await this.getRawBody())
  }

  /** Validate query parameters; throws ValidationException on failure. */
  protected validateQuery<T>(schema: ZodLikeSchema<T>): T {
    return this.runValidation(schema, this.flattenQueries())
  }

  /** Validate route parameters; throws ValidationException on failure. */
  protected validateParams<T>(schema: ZodLikeSchema<T>): T {
    const params = this.ctx.req.param() as Record<string, string>
    return this.runValidation(schema, params)
  }

  /** Validate the request body without throwing; returns data or field errors. */
  protected async validateBodySafe<T>(schema: ZodLikeSchema<T>): Promise<SafeValidationResult<T>> {
    return this.runValidationSafe(schema, await this.getRawBody())
  }

  /** Validate query parameters without throwing; returns data or field errors. */
  protected validateQuerySafe<T>(schema: ZodLikeSchema<T>): SafeValidationResult<T> {
    return this.runValidationSafe(schema, this.flattenQueries())
  }

  /** Validate route parameters without throwing; returns data or field errors. */
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

  /**
   * The parsed body as sent: an array stays an array, so a non-object contract
   * stays reachable. Boxed rather than memoized by truthiness — `null`, `''`,
   * `0` and `false` are parsed bodies, and re-reading would find the stream
   * consumed. No fallback here: {@link parseRequestBody} already yields `{}`.
   */
  private async getRawBody(): Promise<unknown> {
    if (this.parsedBody) {
      return this.parsedBody.value
    }

    this.parsedBody = { value: await parseRequestBody(this.ctx) }
    return this.parsedBody.value
  }

  /** The record view of {@link getRawBody}; a non-object body reads as `{}`. */
  private async getBody(): Promise<Record<string, unknown>> {
    return asRecord(await this.getRawBody())
  }
}
