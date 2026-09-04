import { createMiddleware } from 'hono/factory'

/** Exposes the incoming or generated request ID as `c.get('requestId')`. */
export function requestIdMiddleware() {
  return createMiddleware<{ Variables: { requestId: string } }>(async (c, next) => {
    const requestId = c.req.header('x-request-id') ?? crypto.randomUUID()
    c.set('requestId', requestId)
    await next()
    c.header('X-Request-ID', requestId)
  })
}
