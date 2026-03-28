import { describe, test, expect } from 'bun:test'
import { Hono } from 'hono'
import { requestIdMiddleware } from './request-id'

function createApp() {
  const app = new Hono<{ Variables: { requestId: string } }>()
  app.use('*', requestIdMiddleware())
  app.get('/', (c) => c.json({ requestId: c.get('requestId') }))
  return app
}

describe('requestIdMiddleware', () => {
  test('should generate a request ID when none is provided', async () => {
    const app = createApp()
    const res = await app.request('/')

    const headerValue = res.headers.get('X-Request-ID')
    expect(headerValue).not.toBeNull()
    expect(headerValue!.length).toBeGreaterThan(0)

    const body = await res.json()
    expect(body.requestId).toBe(headerValue)
  })

  test('should reuse the X-Request-ID header from the incoming request', async () => {
    const app = createApp()
    const incomingId = 'custom-request-id-123'

    const res = await app.request('/', {
      headers: { 'X-Request-ID': incomingId },
    })

    expect(res.headers.get('X-Request-ID')).toBe(incomingId)

    const body = await res.json()
    expect(body.requestId).toBe(incomingId)
  })

  test('should generate unique IDs for consecutive requests', async () => {
    const app = createApp()

    const res1 = await app.request('/')
    const res2 = await app.request('/')

    const id1 = res1.headers.get('X-Request-ID')
    const id2 = res2.headers.get('X-Request-ID')

    expect(id1).not.toBeNull()
    expect(id2).not.toBeNull()
    expect(id1).not.toBe(id2)
  })
})
