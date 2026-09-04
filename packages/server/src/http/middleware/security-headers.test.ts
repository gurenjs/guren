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

/**
 * The headers have to land however the handler produced the response. Prepared
 * headers (`ctx.header()` before `next()`) are dropped by a raw
 * `new Response(...)`, which is what the framework's asset handlers return.
 */
describe('createSecurityHeaders response shapes', () => {
  test('should set headers on a handler that returns a raw Response', async () => {
    const app = new Hono()
    app.use('*', createSecurityHeaders())
    app.get('/raw', () => new Response('raw body'))

    const res = await app.request('/raw')

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('raw body')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('X-Frame-Options')).toBe('SAMEORIGIN')
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
  })

  test('should still set headers on a handler that answers through the context', async () => {
    // Regression guard: this is the shape that already worked.
    const app = createApp()

    const res = await app.request('/')

    expect(await res.text()).toBe('ok')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('X-Frame-Options')).toBe('SAMEORIGIN')
  })

  test('should not consume a streamed body', async () => {
    const app = new Hono()
    app.use('*', createSecurityHeaders())
    app.get('/stream', () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('chunk'))
          controller.close()
        },
      })
      return new Response(stream)
    })

    const res = await app.request('/stream')

    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(await res.text()).toBe('chunk')
  })

  test('should set headers on a bodyless response', async () => {
    const app = new Hono()
    app.use('*', createSecurityHeaders())
    app.get('/favicon.ico', () => new Response(null, { status: 204 }))

    const res = await app.request('/favicon.ico')

    expect(res.status).toBe(204)
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  test('should set headers on the error response an exception handler produced', async () => {
    // Regression guard: the prepared-header version covered this shape, because
    // the error handler answers through the same context.
    const app = new Hono()
    app.use('*', createSecurityHeaders())
    app.get('/boom', () => {
      throw new Error('kaboom')
    })
    app.onError((error, ctx) => ctx.json({ message: error.message }, 500))

    const res = await app.request('/boom')

    expect(res.status).toBe(500)
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('X-Frame-Options')).toBe('SAMEORIGIN')
  })

  test('should set headers when the exception handler itself throws and Hono re-renders', async () => {
    // The one shape where `next()` rejects instead of resolving: the error
    // escapes compose and Hono renders it again at its outer boundary, through
    // this same context. Guards the `finally` — a plain post-`next()` call
    // leaves this response bare.
    const app = new Hono()
    let renders = 0
    app.use('*', createSecurityHeaders())
    app.get('/boom', () => {
      throw new Error('kaboom')
    })
    app.onError((error, ctx) => {
      renders += 1
      if (renders === 1) throw new Error('renderer exploded')
      return ctx.json({ message: error.message }, 500)
    })

    const res = await app.request('/boom')

    expect(res.status).toBe(500)
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('X-Frame-Options')).toBe('SAMEORIGIN')
  })

  test('should set headers on a 404 the router never routed', async () => {
    const app = new Hono()
    app.use('*', createSecurityHeaders())
    app.get('/', (c) => c.text('ok'))

    const res = await app.request('/nothing-here')

    expect(res.status).toBe(404)
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })
})

/**
 * First writer wins: anything closer to the handler overrides these defaults —
 * `createForceHttpsMiddleware`'s own Strict-Transport-Security, or a route
 * opting out of X-Frame-Options to allow embedding.
 */
describe('createSecurityHeaders precedence', () => {
  test('should keep a value the handler set on a raw Response and still add the missing ones', async () => {
    const app = new Hono()
    app.use('*', createSecurityHeaders())
    app.get('/embeddable', () => new Response('x', { headers: { 'X-Frame-Options': 'ALLOWALL' } }))

    const res = await app.request('/embeddable')

    expect(res.headers.get('X-Frame-Options')).toBe('ALLOWALL')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  test('should keep a value the handler set through the context', async () => {
    const app = new Hono()
    app.use('*', createSecurityHeaders())
    app.get('/embeddable', (c) => c.text('x', 200, { 'X-Frame-Options': 'ALLOWALL' }))

    const res = await app.request('/embeddable')

    expect(res.headers.get('X-Frame-Options')).toBe('ALLOWALL')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  test('should keep the HSTS value an inner middleware set', async () => {
    // The shape createForceHttpsMiddleware uses: ctx.header() before next().
    const app = new Hono()
    app.use('*', createSecurityHeaders({ hsts: { maxAge: 31536000 } }))
    app.use('*', async (c, next) => {
      c.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains')
      await next()
    })
    app.get('/', (c) => c.text('ok'))

    const res = await app.request('/')

    expect(res.headers.get('Strict-Transport-Security')).toBe(
      'max-age=63072000; includeSubDomains',
    )
  })

  test('should not add a header that is disabled even when the response lacks it', async () => {
    const app = new Hono()
    app.use('*', createSecurityHeaders({ frameOptions: false }))
    app.get('/raw', () => new Response('raw'))

    const res = await app.request('/raw')

    expect(res.headers.get('X-Frame-Options')).toBeNull()
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  test('should leave a disabled header alone when something else set it', async () => {
    // `false` turns off this middleware's default; it is not an instruction to
    // strip a value the app deliberately set.
    const app = new Hono()
    app.use('*', createSecurityHeaders({ frameOptions: false }))
    app.get('/raw', () => new Response('raw', { headers: { 'X-Frame-Options': 'DENY' } }))

    const res = await app.request('/raw')

    expect(res.headers.get('X-Frame-Options')).toBe('DENY')
  })
})

/**
 * A Response from `fetch()` or `Response.redirect()` carries immutable headers
 * on Node and Workers runtimes (Bun allows the write), so a handler proxying an
 * upstream response hands back something that cannot be mutated in place.
 */
describe('createSecurityHeaders immutable headers', () => {
  function withGuardedHeaders(response: Response, error: Error): Response {
    const real = response.headers
    const guarded = new Proxy(real, {
      get(target, prop) {
        if (prop === 'set' || prop === 'append' || prop === 'delete') {
          return () => {
            throw error
          }
        }
        const value = Reflect.get(target, prop, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    Object.defineProperty(response, 'headers', { value: guarded, configurable: true })
    return response
  }

  test('should re-wrap a response whose headers cannot be mutated', async () => {
    const app = new Hono()
    app.use('*', createSecurityHeaders())
    app.get('/proxied', () =>
      withGuardedHeaders(
        new Response('proxied body', { headers: { 'X-Frame-Options': 'ALLOWALL' } }),
        new TypeError('immutable'),
      ),
    )

    const res = await app.request('/proxied')

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('proxied body')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('X-Frame-Options')).toBe('ALLOWALL')
  })

  test('should propagate a header failure that is not the immutable case', async () => {
    // The re-wrap is only for the immutable guard; anything else keeps
    // propagating instead of being swallowed into a silently bare response.
    const app = new Hono()
    let seen: unknown
    app.use('*', createSecurityHeaders())
    app.get('/broken', () =>
      withGuardedHeaders(new Response('x'), new RangeError('something else entirely')),
    )
    app.onError((error, ctx) => {
      seen = error
      return ctx.text(error.message, 500)
    })

    const res = await app.request('/broken')

    expect(res.status).toBe(500)
    expect(await res.text()).toBe('something else entirely')
    expect(seen).toBeInstanceOf(RangeError)
  })
})
