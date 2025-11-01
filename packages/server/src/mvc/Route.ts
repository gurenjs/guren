import type { Context, MiddlewareHandler } from 'hono'
import type { Hono } from 'hono'
import { Controller } from './Controller'

export type ControllerConstructor<T extends Controller = Controller> = new () => T
type ControllerMethod<T extends Controller> = {
  [K in keyof T]: T[K] extends (...args: any[]) => any ? K : never
}[keyof T] & string
export type ControllerAction<T extends Controller = Controller> = [ControllerConstructor<T>, ControllerMethod<T>]
type AnyControllerAction = ControllerAction<Controller>
type RouteResult =
  | Response
  | string
  | number
  | boolean
  | Record<string, unknown>
  | Array<unknown>
  | null
  | void
export type RouteHandler<T extends Controller = Controller> = ((c: Context) => RouteResult | Promise<RouteResult>) | ControllerAction<T>
type AnyRouteHandler = ((c: Context) => RouteResult | Promise<RouteResult>) | AnyControllerAction

interface RegisteredRoute {
  method: string
  path: string
  handler: AnyRouteHandler
  middlewares: MiddlewareHandler[]
  name?: string
}

export interface RouteDefinition {
  method: string
  path: string
  name?: string
}

/**
 * Route registry stores Laravel-style route declarations and eagerly mounts
 * them onto a Hono instance when requested.
 */
export class Route {
  private static readonly registry: RegisteredRoute[] = []
  private static readonly prefixStack: string[] = []

  private static add<T extends Controller>(method: string, path: string, handler: RouteHandler<T>, middlewares: MiddlewareHandler[] = []): typeof Route {
    const fullPath = joinPaths(this.prefixStack, path)
    this.registry.push({ method, path: fullPath, handler: handler as AnyRouteHandler, middlewares })
    return this
  }

  static on<T extends Controller>(method: string, path: string, handler: RouteHandler<T>, ...middlewares: MiddlewareHandler[]): typeof Route {
    return this.add(method.toUpperCase(), path, handler, middlewares)
  }

  static get<T extends Controller>(path: string, handler: RouteHandler<T>, ...middlewares: MiddlewareHandler[]): typeof Route {
    return this.add('GET', path, handler, middlewares)
  }

  static post<T extends Controller>(path: string, handler: RouteHandler<T>, ...middlewares: MiddlewareHandler[]): typeof Route {
    return this.add('POST', path, handler, middlewares)
  }

  static put<T extends Controller>(path: string, handler: RouteHandler<T>, ...middlewares: MiddlewareHandler[]): typeof Route {
    return this.add('PUT', path, handler, middlewares)
  }

  static patch<T extends Controller>(path: string, handler: RouteHandler<T>, ...middlewares: MiddlewareHandler[]): typeof Route {
    return this.add('PATCH', path, handler, middlewares)
  }

  static delete<T extends Controller>(path: string, handler: RouteHandler<T>, ...middlewares: MiddlewareHandler[]): typeof Route {
    return this.add('DELETE', path, handler, middlewares)
  }

  static group(prefix: string, callback: () => void): typeof Route {
    this.prefixStack.push(prefix)
    callback()
    this.prefixStack.pop()
    return this
  }

  static mount(app: Hono): void {
    for (const route of this.registry) {
      const handler = resolveHandler(route.handler)
      app.on(route.method, route.path, ...route.middlewares, handler)
    }
  }

  static clear(): void {
    this.registry.splice(0, this.registry.length)
  }

  static definitions(): RouteDefinition[] {
    return this.registry.map(({ method, path, name }) => ({ method, path, name }))
  }
}

function resolveHandler(action: AnyRouteHandler): MiddlewareHandler {
  if (isControllerAction(action)) {
    const [ControllerClass, methodName] = action
    return async (c) => {
      const controller = new ControllerClass()
      controller.setContext(c)
      const method = controller[methodName]

      if (typeof method !== 'function') {
        throw new Error(`Controller method ${String(methodName)} is not defined on ${ControllerClass.name}.`)
      }

      const result = await method.call(controller, c)
      return ensureResponse(result)
    }
  }

  return async (c) => {
    const result = await action(c)
    return ensureResponse(result)
  }
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
