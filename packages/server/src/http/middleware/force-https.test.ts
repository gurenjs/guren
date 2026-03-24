import { describe, test, expect } from 'bun:test'
import { Hono } from 'hono'
import { createForceHttpsMiddleware } from './force-https'

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
