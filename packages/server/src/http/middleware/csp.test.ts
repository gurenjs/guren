import { describe, test, expect } from 'bun:test'
import { Hono } from 'hono'
import { createCspMiddleware, getCspNonce, CSP_NONCE_KEY } from './csp'

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

    app.request('/')
    // The error is thrown synchronously inside the handler
    expect(threwError).toBe(true)
  })

  test('should not set header when no directives are provided', async () => {
    const app = createApp({})
    const res = await app.request('/')

    expect(res.headers.get('Content-Security-Policy')).toBeNull()
  })
})
