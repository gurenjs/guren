process.env.APP_KEY = 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

import { describe, expect, it, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { Container } from '../../src/container'
import { InertiaServiceProvider } from '../../src/providers/InertiaServiceProvider'
import { ErrorServiceProvider } from '../../src/providers/ErrorServiceProvider'
import { ValidationException } from '../../src/errors/exceptions/ValidationException'
import {
  createSessionMiddleware,
  getSessionFromContext,
  MemorySessionStore,
} from '../../src/http/middleware/session'
import { setInertiaSharedProps } from '../../src/mvc/inertia/shared'

describe('InertiaServiceProvider validation handling', () => {
  let app: Hono
  let container: Container
  let store: MemorySessionStore

  beforeEach(() => {
    // Reset shared props
    setInertiaSharedProps(null)

    container = new Container()
    app = new Hono()
    store = new MemorySessionStore()

    container.instance('hono', app)

    // Session middleware
    app.use('*', createSessionMiddleware({ store, cookieSecure: false }))

    // Register & boot ErrorServiceProvider (uses hono.onError)
    const errorProvider = new ErrorServiceProvider(container)
    errorProvider.register()
    errorProvider.boot()

    // Register & boot InertiaServiceProvider
    const inertiaProvider = new InertiaServiceProvider(container)
    inertiaProvider.register()
    inertiaProvider.boot()

    // A route that throws ValidationException
    app.post('/submit', () => {
      throw new ValidationException({
        email: ['Email is required', 'Email must be valid'],
        password: ['Password is too short'],
      })
    })

    // A route that reads flash data (simulates redirect target)
    app.get('/form', (ctx) => {
      const session = getSessionFromContext(ctx)!
      const errors = session.getFlash<Record<string, string>>('errors')
      return ctx.json({ errors: errors ?? null })
    })
  })

  it('returns 303 redirect with flashed errors for Inertia requests', async () => {
    const res = await app.request('/submit', {
      method: 'POST',
      headers: {
        'X-Inertia': 'true',
        'Referer': 'http://localhost/form',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(303)
    expect(res.headers.get('Location')).toBe('http://localhost/form')
  })

  it('flashes flattened errors to session (first message per field)', async () => {
    // Request 1: POST with Inertia header → 303 redirect
    const res1 = await app.request('/submit', {
      method: 'POST',
      headers: {
        'X-Inertia': 'true',
        'Referer': 'http://localhost/form',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    })

    const cookie = res1.headers.get('set-cookie')!.split(';')[0]

    // Request 2: GET the redirect target — flash data should be available
    const res2 = await app.request('/form', {
      headers: { Cookie: cookie },
    })

    const body = await res2.json() as { errors: Record<string, string> | null }
    expect(body.errors).toEqual({
      email: 'Email is required',
      password: 'Password is too short',
    })
  })

  it('returns 422 JSON for non-Inertia requests', async () => {
    const res = await app.request('/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(422)
    const body = await res.json() as { message: string; errors: Record<string, string[]> }
    expect(body.message).toBe('The given data was invalid.')
    expect(body.errors).toEqual({
      email: ['Email is required', 'Email must be valid'],
      password: ['Password is too short'],
    })
  })

  it('redirects to / when no Referer header is present', async () => {
    const res = await app.request('/submit', {
      method: 'POST',
      headers: {
        'X-Inertia': 'true',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(303)
    expect(res.headers.get('Location')).toBe('/')
  })

  it('flashed errors are gone after one request', async () => {
    const res1 = await app.request('/submit', {
      method: 'POST',
      headers: {
        'X-Inertia': 'true',
        'Referer': 'http://localhost/form',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    })
    const cookie = res1.headers.get('set-cookie')!.split(';')[0]

    // Request 2: read errors
    await app.request('/form', { headers: { Cookie: cookie } })

    // Request 3: errors should be gone
    const res3 = await app.request('/form', { headers: { Cookie: cookie } })
    const body3 = await res3.json() as { errors: Record<string, string> | null }
    expect(body3.errors).toBeNull()
  })

  it('injects errors into shared props resolver', async () => {
    // Set a base shared props resolver
    setInertiaSharedProps(async () => ({ appName: 'Test' }))

    // Re-boot InertiaServiceProvider to wrap the new resolver
    const inertiaProvider = new InertiaServiceProvider(container)
    inertiaProvider.register()
    inertiaProvider.boot()

    // Route that returns resolved shared props
    app.get('/shared', async (ctx) => {
      const { resolveSharedInertiaProps } = await import('../../src/mvc/inertia/shared')
      const shared = await resolveSharedInertiaProps(ctx)
      return ctx.json(shared)
    })

    // Flash errors via POST
    const res1 = await app.request('/submit', {
      method: 'POST',
      headers: {
        'X-Inertia': 'true',
        'Referer': 'http://localhost/shared',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    })
    const cookie = res1.headers.get('set-cookie')!.split(';')[0]

    // Read shared props on redirect target
    const res2 = await app.request('/shared', {
      headers: { Cookie: cookie },
    })
    const body = await res2.json() as { appName: string; errors: Record<string, string> }
    expect(body.appName).toBe('Test')
    expect(body.errors).toEqual({
      email: 'Email is required',
      password: 'Password is too short',
    })
  })
})
