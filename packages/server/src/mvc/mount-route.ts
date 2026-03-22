import type { MiddlewareHandler, Hono } from 'hono'

/**
 * Mounts a route on a Hono app with a dynamic HTTP method string.
 *
 * Hono's app.on() uses complex overloads that expect literal types for the
 * method parameter, making it incompatible with dynamic `string` values at
 * the type level. This helper encapsulates the single narrowing cast needed,
 * keeping the rest of the codebase cast-free.
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
