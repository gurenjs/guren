import { createMiddleware } from 'hono/factory'

/**
 * Logs one structured JSON line per request. Pairs with {@link requestIdMiddleware}:
 * a `requestId` on the context is included in the entry.
 */
export function requestLoggingMiddleware() {
  return createMiddleware(async (c, next) => {
    const start = performance.now()
    const method = c.req.method
    const path = c.req.path

    await next()

    const duration = Math.round(performance.now() - start)
    const status = c.res.status
    const requestId = (c.get as (key: string) => string | undefined)('requestId') ?? '-'

    console.log(JSON.stringify({
      level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
      msg: `${method} ${path} ${status} ${duration}ms`,
      method,
      path,
      status,
      duration,
      requestId,
    }))
  })
}
