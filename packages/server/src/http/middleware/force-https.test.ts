import { describe, test, expect } from 'bun:test'
import { Hono } from 'hono'
import { createForceHttpsMiddleware } from './force-https'
import { createSecurityHeaders } from './security-headers'

describe('createForceHttpsMiddleware', () => {
  test('should redirect HTTP to HTTPS', async () => {
    const app = new Hono()
    app.use('*', createForceHttpsMiddleware())
    app.get('/', (c) => c.text('ok'))

    const res = await app.request('http://example.com/path?q=1')

    expect(res.status).toBe(301)
    expect(res.headers.get('Location')).toBe('https://example.com/path?q=1')
  })

  test('should not redirect HTTPS requests', async () => {
    const app = new Hono()
    app.use('*', createForceHttpsMiddleware())
    app.get('/', (c) => c.text('ok'))

    const res = await app.request('https://example.com/')

    expect(res.status).toBe(200)
  })

  test('should set HSTS header on HTTPS requests', async () => {
    const app = new Hono()
    app.use('*', createForceHttpsMiddleware())
    app.get('/', (c) => c.text('ok'))

    const res = await app.request('https://example.com/')

    expect(res.headers.get('Strict-Transport-Security')).toBe(
      'max-age=31536000; includeSubDomains',
    )
  })

  test('should respect X-Forwarded-Proto header', async () => {
    const app = new Hono()
    app.use('*', createForceHttpsMiddleware())
    app.get('/', (c) => c.text('ok'))

    const res = await app.request('http://example.com/', {
      headers: { 'X-Forwarded-Proto': 'https' },
    })

    expect(res.status).toBe(200)
  })

  test('should allow custom HSTS options', async () => {
    const app = new Hono()
    app.use('*', createForceHttpsMiddleware({
      hstsMaxAge: 86400,
      hstsIncludeSubDomains: false,
      hstsPreload: true,
    }))
    app.get('/', (c) => c.text('ok'))

    const res = await app.request('https://example.com/')

    expect(res.headers.get('Strict-Transport-Security')).toBe('max-age=86400; preload')
  })

  test('should exclude specified paths from redirect', async () => {
    const app = new Hono()
    app.use('*', createForceHttpsMiddleware({ exclude: ['/healthcheck'] }))
    app.get('/healthcheck', (c) => c.text('ok'))

    const res = await app.request('http://example.com/healthcheck')

    expect(res.status).toBe(200)
  })
})

/**
 * The header must land however the handler produced the response. `ctx.header()`
 * before `next()` misses a raw `new Response(...)`, which replaces `ctx.res` —
 * and that is what the framework's own asset handlers return.
 */
describe('createForceHttpsMiddleware response shapes', () => {
  test('should set HSTS header when the handler returns a raw Response', async () => {
    const app = new Hono()
    app.use('*', createForceHttpsMiddleware())
    app.get('/raw', () => new Response('raw body'))

    const res = await app.request('https://example.com/raw')

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('raw body')
    expect(res.headers.get('Strict-Transport-Security')).toBe(
      'max-age=31536000; includeSubDomains',
    )
  })

  test('should still set HSTS header when the handler answers through the context', async () => {
    // Regression guard: this is the shape that already worked.
    const app = new Hono()
    app.use('*', createForceHttpsMiddleware())
    app.get('/', (c) => c.text('ok'))

    const res = await app.request('https://example.com/')

    expect(await res.text()).toBe('ok')
    expect(res.headers.get('Strict-Transport-Security')).toBe(
      'max-age=31536000; includeSubDomains',
    )
  })
})

/**
 * `applyResponseHeaders` is set-if-absent, so the first `finally` to run wins.
 * Registered after `createSecurityHeaders`, force-https is the inner
 * middleware, so its HSTS value lands first and the outer write is a no-op.
 */
describe('createForceHttpsMiddleware precedence over createSecurityHeaders', () => {
  test('wins the Strict-Transport-Security header when mounted inside it', async () => {
    const app = new Hono()
    app.use('*', createSecurityHeaders({ hsts: { maxAge: 100 } }))
    app.use('*', createForceHttpsMiddleware({ hstsMaxAge: 999999, hstsIncludeSubDomains: false }))
    // Only a raw Response distinguishes the two shapes: through ctx.text(),
    // a ctx.header()-before-next() write would reach the response too.
    app.get('/raw', () => new Response('raw body'))

    const res = await app.request('https://example.com/raw')

    expect(res.headers.get('Strict-Transport-Security')).toBe('max-age=999999')
  })
})
