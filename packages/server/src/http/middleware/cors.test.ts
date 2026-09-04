import { describe, test, expect } from 'bun:test'
import { Hono } from 'hono'
import { createCorsMiddleware } from './cors'

describe('createCorsMiddleware', () => {
  test('should not set ACAO header with default options (same-origin policy)', async () => {
    const app = new Hono()
    app.use('*', createCorsMiddleware())
    app.get('/', (c) => c.text('ok'))

    const res = await app.request('/', {
      headers: { Origin: 'http://example.com' },
    })

    const acao = res.headers.get('Access-Control-Allow-Origin')
    expect(!acao || acao === '').toBe(true)
  })

  test('should allow all origins when explicitly set to *', async () => {
    const app = new Hono()
    app.use('*', createCorsMiddleware({ origin: '*' }))
    app.get('/', (c) => c.text('ok'))

    const res = await app.request('/', {
      headers: { Origin: 'http://example.com' },
    })

    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })

  test('should restrict to specific origin', async () => {
    const app = new Hono()
    app.use('*', createCorsMiddleware({
      origin: 'https://example.com',
    }))
    app.get('/', (c) => c.text('ok'))

    const res = await app.request('/', {
      headers: { Origin: 'https://example.com' },
    })

    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com')
  })

  test('should throw when credentials is true without explicit origin', () => {
    expect(() => {
      createCorsMiddleware({ credentials: true })
    }).toThrow('credentials requires an explicit origin')
  })

  // `allowMethods: undefined` spread over Hono's default produces preflights
  // with NO Access-Control-Allow-Methods, so Guren owns the list — QUERY
  // (RFC 10008) included.
  test('preflight without explicit allowMethods advertises the default methods', async () => {
    const app = new Hono()
    app.use('*', createCorsMiddleware({ origin: 'https://example.com' }))
    app.on('QUERY', '/search', (c) => c.json({ ok: true }))

    const res = await app.request('/search', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://example.com',
        'Access-Control-Request-Method': 'QUERY',
      },
    })

    const allowMethods = res.headers.get('Access-Control-Allow-Methods')
    expect(allowMethods).not.toBeNull()
    expect(allowMethods).toContain('QUERY')
    expect(allowMethods).toContain('GET')
  })

  test('should handle preflight OPTIONS request', async () => {
    const app = new Hono()
    app.use('*', createCorsMiddleware({
      origin: 'https://example.com',
      allowMethods: ['GET', 'POST'],
      maxAge: 3600,
    }))
    app.get('/', (c) => c.text('ok'))

    const res = await app.request('/', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://example.com',
        'Access-Control-Request-Method': 'POST',
      },
    })

    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com')
    expect(res.headers.get('Access-Control-Max-Age')).toBe('3600')
  })
})
