import { describe, test, expect } from 'bun:test'
import { Hono } from 'hono'
import { createSecurityHeaders } from './security-headers'

function createApp(options?: Parameters<typeof createSecurityHeaders>[0]) {
  const app = new Hono()
  app.use('*', createSecurityHeaders(options))
  app.get('/', (c) => c.text('ok'))
  return app
}

describe('createSecurityHeaders', () => {
  test('should set all default headers', async () => {
    const app = createApp()
    const res = await app.request('/')

    expect(res.headers.get('X-Frame-Options')).toBe('SAMEORIGIN')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('X-XSS-Protection')).toBe('0')
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
    expect(res.headers.get('X-Permitted-Cross-Domain-Policies')).toBe('none')
    expect(res.headers.get('Strict-Transport-Security')).toBeNull()
  })

  test('should allow disabling individual headers with false', async () => {
    const app = createApp({
      frameOptions: false,
      xssProtection: false,
    })
    const res = await app.request('/')

    expect(res.headers.get('X-Frame-Options')).toBeNull()
    expect(res.headers.get('X-XSS-Protection')).toBeNull()
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  test('should allow custom header values', async () => {
    const app = createApp({
      frameOptions: 'DENY',
      referrerPolicy: 'no-referrer',
    })
    const res = await app.request('/')

    expect(res.headers.get('X-Frame-Options')).toBe('DENY')
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer')
  })

  test('should set HSTS when enabled', async () => {
    const app = createApp({
      hsts: { maxAge: 31536000 },
    })
    const res = await app.request('/')

    expect(res.headers.get('Strict-Transport-Security')).toBe('max-age=31536000')
  })

  test('should set HSTS with includeSubDomains and preload', async () => {
    const app = createApp({
      hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    })
    const res = await app.request('/')

    expect(res.headers.get('Strict-Transport-Security')).toBe(
      'max-age=31536000; includeSubDomains; preload',
    )
  })

  test('should enable HSTS by default in production', async () => {
    const originalEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      const app = createApp()
      const res = await app.request('/')

      expect(res.headers.get('Strict-Transport-Security')).toBe('max-age=31536000')
    } finally {
      process.env.NODE_ENV = originalEnv
    }
  })

  test('should allow disabling HSTS in production with false', async () => {
    const originalEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      const app = createApp({ hsts: false })
      const res = await app.request('/')

      expect(res.headers.get('Strict-Transport-Security')).toBeNull()
    } finally {
      process.env.NODE_ENV = originalEnv
    }
  })
})
