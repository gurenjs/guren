import { createMiddleware } from 'hono/factory'

/**
 * Middleware that generates a unique request ID for each request.
 * Reads from the `X-Request-ID` header if present, otherwise generates one
 * using `crypto.randomUUID()`.
 * Attaches the ID to the Hono context (`c.get('requestId')`) and sets it
 * on the response header.
 *
 * @example
 * ```ts
 * import { requestIdMiddleware } from '@guren/core'
 *
 * app.use('*', requestIdMiddleware())
 * ```
 */
export function requestIdMiddleware() {
  return createMiddleware<{ Variables: { requestId: string } }>(async (c, next) => {
    const requestId = c.req.header('x-request-id') ?? crypto.randomUUID()
    c.set('requestId', requestId)
    await next()
    c.header('X-Request-ID', requestId)
  })
}
