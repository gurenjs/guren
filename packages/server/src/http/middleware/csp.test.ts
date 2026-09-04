import { describe, test, expect } from 'bun:test'
import { Hono } from 'hono'
import { createCspMiddleware, getCspNonce } from './csp'

function createApp(options?: Parameters<typeof createCspMiddleware>[0]) {
  const app = new Hono()
  app.use('*', createCspMiddleware(options))
  app.get('/', (c) => c.text('ok'))
  return app
}

describe('createCspMiddleware', () => {
  test('should set Content-Security-Policy header', async () => {
    const app = createApp({
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://cdn.example.com'],
      },
    })
    const res = await app.request('/')
    const csp = res.headers.get('Content-Security-Policy')

    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("script-src 'self' https://cdn.example.com")
  })

  test('should use report-only header when reportOnly is true', async () => {
    const app = createApp({
      directives: { defaultSrc: ["'self'"] },
      reportOnly: true,
    })
    const res = await app.request('/')

    expect(res.headers.get('Content-Security-Policy')).toBeNull()
    expect(res.headers.get('Content-Security-Policy-Report-Only')).toContain("default-src 'self'")
  })

  test('should append report-uri', async () => {
    const app = createApp({
      directives: { defaultSrc: ["'self'"] },
      reportUri: '/csp-report',
    })
    const res = await app.request('/')
    const csp = res.headers.get('Content-Security-Policy')

    expect(csp).toContain('report-uri /csp-report')
  })

  test('should handle boolean directives', async () => {
    const app = createApp({
      directives: {
        defaultSrc: ["'self'"],
        upgradeInsecureRequests: true,
        blockAllMixedContent: false,
      },
    })
    const res = await app.request('/')
    const csp = res.headers.get('Content-Security-Policy')

    expect(csp).toContain('upgrade-insecure-requests')
    expect(csp).not.toContain('block-all-mixed-content')
  })

  test('should generate nonce when useNonce is true', async () => {
    const app = new Hono()
    app.use('*', createCspMiddleware({
      directives: {
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
      },
      useNonce: true,
    }))
    let capturedNonce = ''
    app.get('/', (c) => {
      capturedNonce = getCspNonce(c)
      return c.text('ok')
    })

    const res = await app.request('/')
    const csp = res.headers.get('Content-Security-Policy')

    expect(capturedNonce).toBeTruthy()
    expect(csp).toContain(`'nonce-${capturedNonce}'`)
    expect(csp).toContain('script-src')
    expect(csp).toContain('style-src')
  })

  test('getCspNonce should throw when nonce is not available', () => {
    const app = new Hono()
    app.use('*', createCspMiddleware({
      directives: { defaultSrc: ["'self'"] },
    }))
    let threwError = false
    app.get('/', (c) => {
      try {
        getCspNonce(c)
      } catch {
        threwError = true
      }
      return c.text('ok')
    })

    void app.request('/')
    // The error is thrown synchronously inside the handler
    expect(threwError).toBe(true)
  })

  test('should not set header when no directives are provided', async () => {
    const app = createApp({})
    const res = await app.request('/')

    expect(res.headers.get('Content-Security-Policy')).toBeNull()
  })
})

/**
 * The header must land however the handler produced the response. `ctx.header()`
 * before `next()` misses a raw `new Response(...)`, which replaces `ctx.res` —
 * and that is what the framework's own asset handlers return.
 */
describe('createCspMiddleware response shapes', () => {
  test('should set CSP header when the handler returns a raw Response', async () => {
    const app = new Hono()
    app.use('*', createCspMiddleware({ directives: { defaultSrc: ["'self'"] } }))
    app.get('/raw', () => new Response('raw body'))

    const res = await app.request('/raw')

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('raw body')
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'self'")
  })

  test('should still set CSP header when the handler answers through the context', async () => {
    // Regression guard: this is the shape that already worked.
    const app = createApp({ directives: { defaultSrc: ["'self'"] } })

    const res = await app.request('/')

    expect(await res.text()).toBe('ok')
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'self'")
  })
})
