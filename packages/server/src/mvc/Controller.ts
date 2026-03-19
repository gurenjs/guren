import type { Context } from 'hono'
import { inertia, type InertiaOptions } from './inertia/InertiaEngine'
import { resolveSharedInertiaProps, type ResolvedSharedInertiaProps } from './inertia/shared'
import { AUTH_CONTEXT_KEY } from '../http/middleware/auth'
import { parseRequestPayload } from '../http/request'
import type { AuthContext } from '../auth'
import type { FormRequest } from '../http/FormRequest'
import { ValidationException } from '../errors/exceptions/ValidationException'

/**
 * Duck-type interface for Zod-like schemas.
 * Allows validation without a direct Zod dependency.
 */
interface ZodLikeSchema<T> {
  safeParse(data: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: Array<{ path: (string | number)[]; message: string }> } }
}

type DefaultInertiaProps = Record<string, unknown>

export type AuthPayload = Record<string, unknown> & { user: unknown }

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

  setContext(context: Context): void {
    this.context = context
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

  protected get auth(): AuthContext {
    const auth = this.ctx.get(AUTH_CONTEXT_KEY) as AuthContext | undefined
    if (!auth) {
      throw new Error('Controller auth helper requires the auth middleware. Make sure AuthServiceProvider is registered.')
    }

    return auth
  }

  // ─── Response Helpers ───────────────────────────────────────────

  protected async inertia<Component extends string, Props extends DefaultInertiaProps>(
    component: Component,
    props: Props,
    options: InertiaResponseOptions = {},
  ): Promise<InertiaResponse<Component, Props & ResolvedSharedInertiaProps>> {
    const ctx = this.ctx
    const { url: overrideUrl, ...rest } = options
    const url = overrideUrl ?? ctx.req.path ?? ctx.req.url ?? ''

    const sharedProps = await resolveSharedInertiaProps(ctx)
    const propsWithShared = { ...sharedProps, ...props } as Props & ResolvedSharedInertiaProps

    const response = await inertia(component, propsWithShared as Record<string, unknown>, {
      ...rest,
      url,
      request: ctx.req.raw,
    })

    ;(response as InertiaResponse<Component, typeof propsWithShared>).__gurenInertia = {
      component,
      props: propsWithShared,
    }

    return response as InertiaResponse<Component, typeof propsWithShared>
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

  // ─── Validation ─────────────────────────────────────────────────

  /**
   * Validate the request using a FormRequest class.
   * Returns typed, validated data. Throws ValidationException on failure.
   *
   * @example
   * ```typescript
   * async store() {
   *   const data = await this.validate(StorePostRequest)
   *   const post = await Post.create(data)
   *   return this.redirect('/posts')
   * }
   * ```
   */
  protected async validate<T>(
    requestClass: new () => FormRequest<T>,
  ): Promise<T> {
    const formRequest = new requestClass()
    return formRequest.handle(this.ctx)
  }

  // ─── Zod Validation Helpers ────────────────────────────────────

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
    const queries = this.ctx.req.queries()
    // Flatten single-element arrays to scalar values for cleaner schema usage
    const flat: Record<string, unknown> = {}
    for (const [key, values] of Object.entries(queries)) {
      flat[key] = values.length === 1 ? values[0] : values
    }
    return this.runValidation(schema, flat)
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

  private runValidation<T>(schema: ZodLikeSchema<T>, data: unknown): T {
    const result = schema.safeParse(data)
    if (result.success) {
      return result.data
    }
    throw ValidationException.fromZodError(result.error)
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
