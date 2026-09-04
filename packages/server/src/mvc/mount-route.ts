import type { MiddlewareHandler, Hono } from 'hono'

/**
 * Mounts a route with a dynamic HTTP method string. Hono's `app.on()` overloads
 * expect literal method types, so this helper holds the one narrowing cast.
 */
export function mountRoute(
  app: Hono,
  method: string,
  path: string,
  ...handlers: MiddlewareHandler[]
): void {
  type OnFn = (method: string, path: string, ...handlers: MiddlewareHandler[]) => unknown
  ;(app.on as OnFn)(method, path, ...handlers)
}
