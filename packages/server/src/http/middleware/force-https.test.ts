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

    // Request appears HTTP but X-Forwarded-Proto says HTTPS (behind proxy)
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
 * The header has to land on the response however the handler produced it.
 * Setting it with `ctx.header()` before `next()` only reaches responses the
 * handler built through the context — a raw `new Response(...)` replaces
 * `ctx.res` and drops it, which is exactly what the framework's own asset
 * handlers return.
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
 * `applyResponseHeaders` is set-if-absent, so whichever middleware's `finally`
 * runs first supplies the value. Mounted inside `createSecurityHeaders` (i.e.
 * registered after it), force-https is the inner middleware — its `finally`
 * fires before the outer `createSecurityHeaders` finally gets a turn, so its
 * HSTS value reaches the response first and security-headers' own HSTS write
 * becomes a no-op.
 */
describe('createForceHttpsMiddleware precedence over createSecurityHeaders', () => {
  test('wins the Strict-Transport-Security header when mounted inside it', async () => {
    const app = new Hono()
    app.use('*', createSecurityHeaders({ hsts: { maxAge: 100 } }))
    app.use('*', createForceHttpsMiddleware({ hstsMaxAge: 999999, hstsIncludeSubDomains: false }))
    // A raw Response is what actually distinguishes the two implementations:
    // through ctx.text(), a header set via ctx.header() before next() also
    // reaches the final response, so this precedence would hold even with the
    // old ctx.header()-before-next() shape. Only a raw Response exposes it.
    app.get('/raw', () => new Response('raw body'))

    const res = await app.request('https://example.com/raw')

    expect(res.headers.get('Strict-Transport-Security')).toBe('max-age=999999')
  })
})
