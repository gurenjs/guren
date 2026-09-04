import { describe, test, expect } from 'bun:test'
import { Hono } from 'hono'
import { createHostAuthorizationMiddleware } from './host-authorization'

function createApp(options: Parameters<typeof createHostAuthorizationMiddleware>[0]) {
  const app = new Hono()
  app.use('*', createHostAuthorizationMiddleware(options))
  app.get('/', (c) => c.text('ok'))
  app.get('/healthcheck', (c) => c.text('healthy'))
  return app
}

describe('createHostAuthorizationMiddleware', () => {
  test('should allow requests with matching host', async () => {
    const app = createApp({ allowedHosts: ['example.com'] })
    const res = await app.request('http://example.com/')

    expect(res.status).toBe(200)
  })

  test('should reject requests with non-matching host', async () => {
    const app = createApp({ allowedHosts: ['example.com'] })
    const res = await app.request('http://evil.com/')

    expect(res.status).toBe(403)
  })

  test('should support wildcard subdomains', async () => {
    const app = createApp({ allowedHosts: ['*.example.com'] })

    const res1 = await app.request('http://app.example.com/')
    expect(res1.status).toBe(200)

    const res2 = await app.request('http://example.com/')
    expect(res2.status).toBe(403)

    const res3 = await app.request('http://evil.com/')
    expect(res3.status).toBe(403)
  })

  test('should support port matching', async () => {
    const app = createApp({ allowedHosts: ['localhost:3000'] })

    const res = await app.request('http://localhost:3000/')
    expect(res.status).toBe(200)
  })

  test('should be case-insensitive', async () => {
    const app = createApp({ allowedHosts: ['Example.COM'] })
    const res = await app.request('http://example.com/')

    expect(res.status).toBe(200)
  })

  test('should exclude specified paths', async () => {
    const app = createApp({
      allowedHosts: ['example.com'],
      exclude: ['/healthcheck'],
    })
    const res = await app.request('http://evil.com/healthcheck')

    expect(res.status).toBe(200)
  })

  test('should support wildcard path exclusions', async () => {
    const app2 = new Hono()
    app2.use('*', createHostAuthorizationMiddleware({
      allowedHosts: ['example.com'],
      exclude: ['/api/*'],
    }))
    app2.get('/api/health', (c) => c.text('ok'))

    const res = await app2.request('http://evil.com/api/health')
    expect(res.status).toBe(200)
  })

  test('should reject port-embedded host tricks', async () => {
    const app = createApp({ allowedHosts: ['*.example.com'] })

    const res = await app.request('http://localhost/', {
      headers: { Host: 'attacker.com:80.example.com' },
    })
    expect(res.status).toBe(403)
  })

  test('should support port wildcard matching', async () => {
    const app = createApp({ allowedHosts: ['localhost:*'] })

    const res1 = await app.request('http://localhost:3000/')
    expect(res1.status).toBe(200)

    const res2 = await app.request('http://localhost:8080/')
    expect(res2.status).toBe(200)

    const res3 = await app.request('http://localhost/')
    expect(res3.status).toBe(200)

    const res4 = await app.request('http://evil.com/')
    expect(res4.status).toBe(403)
  })

  test('should use custom error handler when provided', async () => {
    const app = createApp({
      allowedHosts: ['example.com'],
      onError: (ctx) => ctx.json({ error: 'bad host' }, 421),
    })
    const res = await app.request('http://evil.com/')

    expect(res.status).toBe(421)
    const body = await res.json()
    expect(body).toEqual({ error: 'bad host' })
  })
})
