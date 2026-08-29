import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import {
  AUTH_CONTEXT_KEY,
  attachAuthContext,
  requireAuthenticated,
  requireGuest,
  type AuthContext,
} from '../../../src/http/middleware/auth'
import { createMockAuthContext } from '@guren/testing'

describe('attachAuthContext', () => {
  it('attaches auth context to the request', async () => {
    const app = new Hono()
    const mockAuth = createMockAuthContext({ isAuthenticated: true })

    app.use(attachAuthContext(() => mockAuth))
    app.get('/test', async (c) => {
      const auth = (c as unknown as { get: (key: string) => AuthContext }).get(AUTH_CONTEXT_KEY)
      const user = await auth.user()
      return c.json({ user })
    })

    const res = await app.request('/test')
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ user: { id: 1, name: 'Test User' } })
  })
})

describe('requireAuthenticated', () => {
  it('allows authenticated users to proceed', async () => {
    const app = new Hono()
    const mockAuth = createMockAuthContext({ isAuthenticated: true })

    app.use(attachAuthContext(() => mockAuth))
    app.use('/protected/*', requireAuthenticated())
    app.get('/protected/resource', (c) => c.text('secret data'))

    const res = await app.request('/protected/resource')

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('secret data')
  })

  it('returns 401 for unauthenticated users by default', async () => {
    const app = new Hono()
    const mockAuth = createMockAuthContext({ isAuthenticated: false })

    app.use(attachAuthContext(() => mockAuth))
    app.use('/protected/*', requireAuthenticated())
    app.get('/protected/resource', (c) => c.text('secret data'))

    const res = await app.request('/protected/resource')

    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body).toEqual({ message: 'Unauthorized' })
  })

  it('redirects unauthenticated users when redirectTo is set', async () => {
    const app = new Hono()
    const mockAuth = createMockAuthContext({ isAuthenticated: false })

    app.use(attachAuthContext(() => mockAuth))
    app.use('/protected/*', requireAuthenticated({ redirectTo: '/login' }))
    app.get('/protected/resource', (c) => c.text('secret data'))

    const res = await app.request('/protected/resource')

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login')
  })

  it('uses custom status code when provided', async () => {
    const app = new Hono()
    const mockAuth = createMockAuthContext({ isAuthenticated: false })

    app.use(attachAuthContext(() => mockAuth))
    app.use('/protected/*', requireAuthenticated({ status: 403 }))
    app.get('/protected/resource', (c) => c.text('secret data'))

    const res = await app.request('/protected/resource')

    expect(res.status).toBe(403)
  })

  it('uses custom response factory when provided', async () => {
    const app = new Hono()
    const mockAuth = createMockAuthContext({ isAuthenticated: false })

    app.use(attachAuthContext(() => mockAuth))
    app.use(
      '/protected/*',
      requireAuthenticated({
        responseFactory: () =>
          new Response('Custom unauthorized', {
            status: 401,
            headers: { 'X-Custom': 'header' },
          }),
      }),
    )
    app.get('/protected/resource', (c) => c.text('secret data'))

    const res = await app.request('/protected/resource')

    expect(res.status).toBe(401)
    expect(await res.text()).toBe('Custom unauthorized')
    expect(res.headers.get('X-Custom')).toBe('header')
  })

  it('throws error when auth context is not attached', async () => {
    const app = new Hono()

    app.use('/protected/*', requireAuthenticated())
    app.get('/protected/resource', (c) => c.text('secret data'))

    app.onError((err, c) => {
      return c.json({ error: err.message }, 500)
    })

    const res = await app.request('/protected/resource')

    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toContain('Auth context has not been attached')
  })
})

describe('requireGuest', () => {
  it('allows guest users to proceed', async () => {
    const app = new Hono()
    const mockAuth = createMockAuthContext({ isAuthenticated: false })

    app.use(attachAuthContext(() => mockAuth))
    app.use('/login', requireGuest())
    app.get('/login', (c) => c.text('login form'))

    const res = await app.request('/login')

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('login form')
  })

  it('returns 403 for authenticated users by default', async () => {
    const app = new Hono()
    const mockAuth = createMockAuthContext({ isAuthenticated: true })

    app.use(attachAuthContext(() => mockAuth))
    app.use('/login', requireGuest())
    app.get('/login', (c) => c.text('login form'))

    const res = await app.request('/login')

    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body).toEqual({ message: 'Already authenticated' })
  })

  it('redirects authenticated users when redirectTo is set', async () => {
    const app = new Hono()
    const mockAuth = createMockAuthContext({ isAuthenticated: true })

    app.use(attachAuthContext(() => mockAuth))
    app.use('/login', requireGuest({ redirectTo: '/dashboard' }))
    app.get('/login', (c) => c.text('login form'))

    const res = await app.request('/login')

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/dashboard')
  })

  it('uses custom status code when provided', async () => {
    const app = new Hono()
    const mockAuth = createMockAuthContext({ isAuthenticated: true })

    app.use(attachAuthContext(() => mockAuth))
    app.use('/login', requireGuest({ status: 400 }))
    app.get('/login', (c) => c.text('login form'))

    const res = await app.request('/login')

    expect(res.status).toBe(400)
  })

  it('uses custom response factory when provided', async () => {
    const app = new Hono()
    const mockAuth = createMockAuthContext({ isAuthenticated: true })

    app.use(attachAuthContext(() => mockAuth))
    app.use(
      '/login',
      requireGuest({
        responseFactory: () =>
          new Response('Go away', {
            status: 403,
          }),
      }),
    )
    app.get('/login', (c) => c.text('login form'))

    const res = await app.request('/login')

    expect(res.status).toBe(403)
    expect(await res.text()).toBe('Go away')
  })

  it('throws error when auth context is not attached', async () => {
    const app = new Hono()

    app.use('/login', requireGuest())
    app.get('/login', (c) => c.text('login form'))

    app.onError((err, c) => {
      return c.json({ error: err.message }, 500)
    })

    const res = await app.request('/login')

    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toContain('Auth context has not been attached')
  })
})
