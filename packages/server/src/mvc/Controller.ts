import type { Context } from 'hono'
import { inertia, type InertiaOptions } from './inertia/InertiaEngine'
import { resolveSharedInertiaProps, type ResolvedSharedInertiaProps } from './inertia/shared'
import { AUTH_CONTEXT_KEY } from '../http/middleware/auth'
import type { AuthContext } from '../auth'

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
 * Base controller inspired by Laravel's expressive API. Subclasses can access
 * the current Hono context through the protected `ctx` getter and rely on the
 * helper response builders for common patterns.
 */
export class Controller {
  private context?: Context

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
}
