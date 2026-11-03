process.env.APP_KEY = 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
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

  // A fresh container per test isolates the provider's shared props; only the
  // test using the module-global registry needs this reset.
  afterEach(() => {
    setInertiaSharedProps(null)
  })

  beforeEach(() => {
    container = new Container()
    app = new Hono()
    store = new MemorySessionStore()

    container.instance('hono', app)

    app.use('*', createSessionMiddleware({ store, cookieSecure: false }))

    // ErrorServiceProvider installs its handler on hono.onError.
    const errorProvider = new ErrorServiceProvider(container)
    errorProvider.register()
    errorProvider.boot()

    const inertiaProvider = new InertiaServiceProvider(container)
    inertiaProvider.register()
    inertiaProvider.boot()

    app.post('/submit', () => {
      throw new ValidationException({
        email: ['Email is required', 'Email must be valid'],
        password: ['Password is too short'],
      })
    })

    // Simulates the redirect target.
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
    expect(res.headers.get('Location')).toBe('/form')
  })

  it('flashes flattened errors to session (first message per field)', async () => {
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

  // Behind a TLS-terminating proxy the request reads http: while the browser's Referer reads https:.
  it('redirects back to an https Referer on the same host, by its path', async () => {
    const res = await app.request('/submit', {
      method: 'POST',
      headers: { 'X-Inertia': 'true', Referer: 'https://localhost/posts/1/edit?tab=body' },
    })

    expect(res.status).toBe(303)
    expect(res.headers.get('Location')).toBe('/posts/1/edit?tab=body')
  })

  // A proxy that does not forward Host hands the app its upstream address.
  it('redirects back to a Referer on the APP_URL host from the validated env', async () => {
    container.instance('env', { APP_URL: 'https://app.example.com' })

    const res = await app.request('http://10.0.0.5:3000/submit', {
      method: 'POST',
      headers: { 'X-Inertia': 'true', Referer: 'https://app.example.com/posts/1/edit' },
    })

    expect(res.headers.get('Location')).toBe('/posts/1/edit')
  })

  it('reads APP_URL from process.env when the app declares no env schema', async () => {
    const previous = process.env.APP_URL
    process.env.APP_URL = 'https://app.example.com'
    try {
      const res = await app.request('http://10.0.0.5:3000/submit', {
        method: 'POST',
        headers: { 'X-Inertia': 'true', Referer: 'https://app.example.com/posts/1/edit' },
      })

      expect(res.headers.get('Location')).toBe('/posts/1/edit')
    } finally {
      if (previous === undefined) delete process.env.APP_URL
      else process.env.APP_URL = previous
    }
  })

  it.each([
    'https://evil.example/x',
    'http://localhost:4000/form',
    '//evil.example/x',
    '/\\evil.example/x',
    '/\t/evil.example/x',
    'http://localhost//evil.example/x',
    'javascript://localhost/%0aalert(1)',
  ])('redirects to / for a Referer that leaves the app: %p', async (referer) => {
    const res = await app.request('/submit', {
      method: 'POST',
      headers: { 'X-Inertia': 'true', Referer: referer },
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

    await app.request('/form', { headers: { Cookie: cookie } })

    const res3 = await app.request('/form', { headers: { Cookie: cookie } })
    const body3 = await res3.json() as { errors: Record<string, string> | null }
    expect(body3.errors).toBeNull()
  })

  it('merges flashed errors over module-global shared props', async () => {
    // A bare-Hono style global resolver stays underneath the provider's
    // container-scoped errors resolver.
    setInertiaSharedProps(async () => ({ appName: 'Test' }))

    app.get('/shared', async (ctx) => {
      const { resolveSharedInertiaProps } = await import('../../src/mvc/inertia/shared')
      const shared = await resolveSharedInertiaProps(ctx, container)
      return ctx.json(shared)
    })

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
