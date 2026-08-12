process.env.APP_KEY = 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { Container } from '../../src/container'
import { InertiaServiceProvider } from '../../src/providers/InertiaServiceProvider'
import { ErrorServiceProvider } from '../../src/providers/ErrorServiceProvider'
import { ValidationException } from '../../src/errors/exceptions/ValidationException'
import { setInertiaSharedProps, resolveSharedInertiaProps } from '../../src/mvc/inertia/shared'
import { VALIDATION_ERRORS_COOKIE } from '../../src/http/middleware/validation-errors-cookie'

/**
 * Apps without `createApp({ auth })` have no session middleware, so the
 * Laravel-style "flash to session" path has nowhere to put validation errors.
 * These tests pin the cookie-flash fallback: the errors still make the
 * redirect round trip, and the cookie disappears after the render that
 * consumed it.
 */
describe('InertiaServiceProvider validation handling without a session', () => {
  let app: Hono
  let container: Container

  afterEach(() => {
    setInertiaSharedProps(null)
  })

  beforeEach(() => {
    container = new Container()
    app = new Hono()

    container.instance('hono', app)

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

    // Simulates the redirect target: renders the shared props the Inertia
    // response would receive.
    app.get('/form', async (ctx) => {
      const shared = await resolveSharedInertiaProps(ctx, container)
      return ctx.json(shared)
    })

    // A response that never resolves shared props — an intermediate redirect,
    // a health check — must not burn the flash.
    app.get('/passthrough', (ctx) => ctx.text('ok'))
  })

  function extractErrorsCookie(res: Response): string {
    const header = res.headers
      .getSetCookie()
      .find((value) => value.startsWith(`${VALIDATION_ERRORS_COOKIE}=`))
    expect(header).toBeDefined()
    return header!.split(';')[0]
  }

  it('flashes errors through a cookie on the 303 redirect', async () => {
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

    const header = res.headers
      .getSetCookie()
      .find((value) => value.startsWith(`${VALIDATION_ERRORS_COOKIE}=`))!
    expect(header).toContain('HttpOnly')
    expect(header).toContain('SameSite=Lax')
    expect(header).toContain('Max-Age=60')
  })

  it('delivers flattened errors to shared props on the redirect target', async () => {
    const res1 = await app.request('/submit', {
      method: 'POST',
      headers: {
        'X-Inertia': 'true',
        'Referer': 'http://localhost/form',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    })

    const cookie = extractErrorsCookie(res1)
    const res2 = await app.request('/form', { headers: { Cookie: cookie } })

    const body = (await res2.json()) as { errors?: Record<string, string> }
    expect(body.errors).toEqual({
      email: 'Email is required',
      password: 'Password is too short',
    })
  })

  it('expires the cookie on the response that consumed it', async () => {
    const res1 = await app.request('/submit', {
      method: 'POST',
      headers: {
        'X-Inertia': 'true',
        'Referer': 'http://localhost/form',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    })

    const cookie = extractErrorsCookie(res1)
    const res2 = await app.request('/form', { headers: { Cookie: cookie } })

    const expired = res2.headers
      .getSetCookie()
      .find((value) => value.startsWith(`${VALIDATION_ERRORS_COOKIE}=`))
    expect(expired).toBeDefined()
    expect(expired).toContain('Max-Age=0')
  })

  it('does not expire a cookie the same response just set', async () => {
    // A failed submit arriving with a stale flash cookie: the renderer sets a
    // fresh one on the 303, and the cleanup must not stamp Max-Age=0 over it.
    const res = await app.request('/submit', {
      method: 'POST',
      headers: {
        'X-Inertia': 'true',
        'Referer': 'http://localhost/form',
        'Content-Type': 'application/json',
        Cookie: `${VALIDATION_ERRORS_COOKIE}=${encodeURIComponent(JSON.stringify({ stale: 'old' }))}`,
      },
      body: JSON.stringify({}),
    })

    const headers = res.headers
      .getSetCookie()
      .filter((value) => value.startsWith(`${VALIDATION_ERRORS_COOKIE}=`))
    expect(headers).toHaveLength(1)
    expect(headers[0]).not.toContain('Max-Age=0')
  })

  it('ignores a malformed cookie', async () => {
    const res = await app.request('/form', {
      headers: { Cookie: `${VALIDATION_ERRORS_COOKIE}=not-json` },
    })

    const body = (await res.json()) as { errors?: Record<string, string> }
    expect(body.errors).toBeUndefined()
  })

  it('keeps the flash alive across responses that never render it', async () => {
    // Session flashes survive intermediate hops because they are consumed on
    // read; the cookie flash must match. A trailing-slash redirect or an auth
    // bounce between the 303 and the actual render must not burn the errors.
    const res1 = await app.request('/submit', {
      method: 'POST',
      headers: {
        'X-Inertia': 'true',
        'Referer': 'http://localhost/form',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    })

    const cookie = extractErrorsCookie(res1)
    const passthrough = await app.request('/passthrough', { headers: { Cookie: cookie } })

    const expired = passthrough.headers
      .getSetCookie()
      .find((value) => value.startsWith(`${VALIDATION_ERRORS_COOKIE}=`))
    expect(expired).toBeUndefined()

    const res2 = await app.request('/form', { headers: { Cookie: cookie } })
    const body = (await res2.json()) as { errors?: Record<string, string> }
    expect(body.errors).toEqual({
      email: 'Email is required',
      password: 'Password is too short',
    })
  })

  it('keeps smaller fields when an oversized field is skipped', async () => {
    // The oversized field is dropped individually; a `break` here would lose
    // every error that follows it, sending an empty cookie instead.
    app.post('/submit-lopsided', () => {
      throw new ValidationException({
        essay: ['x'.repeat(5000)],
        email: ['Email is required'],
      })
    })

    const res = await app.request('/submit-lopsided', {
      method: 'POST',
      headers: {
        'X-Inertia': 'true',
        'Referer': 'http://localhost/form',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    })

    const cookie = extractErrorsCookie(res)
    const res2 = await app.request('/form', { headers: { Cookie: cookie } })
    const body = (await res2.json()) as { errors?: Record<string, string> }
    expect(body.errors).toEqual({ email: 'Email is required' })
  })

  it('truncates oversized error sets by whole fields instead of losing the cookie', async () => {
    app.post('/submit-huge', () => {
      const errors: Record<string, string[]> = {}
      for (let index = 0; index < 100; index += 1) {
        errors[`field${index}`] = ['x'.repeat(200)]
      }
      throw new ValidationException(errors)
    })

    const res = await app.request('/submit-huge', {
      method: 'POST',
      headers: {
        'X-Inertia': 'true',
        'Referer': 'http://localhost/form',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    })

    const cookie = extractErrorsCookie(res)
    // Deliverable size: attribute-free value stays under the browser cap.
    expect(cookie.length).toBeLessThan(4096)

    const res2 = await app.request('/form', { headers: { Cookie: cookie } })
    const body = (await res2.json()) as { errors?: Record<string, string> }
    expect(body.errors).toBeDefined()
    expect(Object.keys(body.errors!).length).toBeGreaterThan(0)
    expect(Object.keys(body.errors!).length).toBeLessThan(100)
    expect(body.errors!.field0).toBe('x'.repeat(200))
  })
})
