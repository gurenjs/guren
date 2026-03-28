import { createMiddleware } from 'hono/factory'

/**
 * Middleware that logs HTTP requests with method, path, status, and duration.
 * Uses structured JSON format suitable for production monitoring and log collectors.
 *
 * Pairs well with {@link requestIdMiddleware} — if a `requestId` is set on the
 * context, it will be included in the log entry.
 *
 * @example
 * ```ts
 * import { requestIdMiddleware, requestLoggingMiddleware } from '@guren/core'
 *
 * app.use('*', requestIdMiddleware())
 * app.use('*', requestLoggingMiddleware())
 * ```
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
