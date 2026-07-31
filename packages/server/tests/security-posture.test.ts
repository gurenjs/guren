process.env.APP_KEY = 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

import { describe, expect, it } from 'bun:test'
import { Application, requireAuthenticated } from '../src'
import { getSessionFromContext } from '../src/http/middleware/session'
import { MCP_ENDPOINT_PATH } from '../src/mcp/endpoint'

/**
 * Locks the framework's secure DEFAULTS in one place.
 *
 * Every assertion here is a security decision the framework has already
 * made: what an app gets when the developer configures nothing. The
 * per-middleware test files cover option behavior; this file covers the
 * wiring. If a change makes this file fail — or edits it — that diff IS
 * the security review trigger. Do not weaken an assertion here to make
 * a refactor pass without treating it as a deliberate change of the
 * framework's security posture.
 */

async function bootDefaultApp(): Promise<Application> {
  const app = new Application()
  app.router.get('/probe', () => 'ok')
  await app.boot()
  return app
}

async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  const saved = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await run()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

describe('security posture: default response headers', () => {
  it('every response carries the hardening headers without any configuration', async () => {
    const app = await bootDefaultApp()
    const response = await app.fetch(new Request('http://example.com/probe'))

    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(response.headers.get('X-Frame-Options')).toBe('SAMEORIGIN')
    expect(response.headers.get('X-XSS-Protection')).toBe('0')
    expect(response.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
    expect(response.headers.get('X-Permitted-Cross-Domain-Policies')).toBe('none')
  })

  it('does not send HSTS outside production (meaningless without TLS, and sticky)', async () => {
    const app = await bootDefaultApp()
    const response = await app.fetch(new Request('http://example.com/probe'))

    expect(response.headers.get('Strict-Transport-Security')).toBeNull()
  })

  it('sends one-year HSTS when booted in production', async () => {
    await withEnv({ NODE_ENV: 'production' }, async () => {
      const app = await bootDefaultApp()
      const response = await app.fetch(new Request('http://example.com/probe'))

      expect(response.headers.get('Strict-Transport-Security')).toBe('max-age=31536000')
    })
  })

  it('stays same-origin: no CORS header unless the app opts in', async () => {
    const app = await bootDefaultApp()
    const response = await app.fetch(
      new Request('http://example.com/probe', { headers: { Origin: 'https://evil.example' } }),
    )

    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })
})

describe('security posture: session and CSRF defaults for auth apps', () => {
  async function bootAuthApp(): Promise<{ app: Application; mutated: () => boolean }> {
    let handlerRan = false
    const app = new Application({ auth: {} })
    app.router.get('/login-form', () => 'form')
    app.router.get('/remember', (ctx) => {
      getSessionFromContext(ctx)!.set('seen', true)
      return ctx.json({ ok: true })
    })
    app.router.post('/mutate', () => {
      handlerRan = true
      return 'mutated'
    })
    await app.boot()
    return { app, mutated: () => handlerRan }
  }

  it('rejects a tokenless mutating request with 403 before the handler runs', async () => {
    const { app, mutated } = await bootAuthApp()

    const response = await app.fetch(new Request('http://example.com/mutate', { method: 'POST' }))

    expect(response.status).toBe(403)
    expect(mutated()).toBe(false)
  })

  it('accepts the same mutation when the XSRF cookie/header pair is presented', async () => {
    // Proves the 403 above is the CSRF middleware and not some other failure.
    const { app, mutated } = await bootAuthApp()

    const seed = await app.fetch(new Request('http://example.com/login-form'))
    const xsrfCookie = seed.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith('XSRF-TOKEN='))!
    const token = decodeURIComponent(xsrfCookie.split(';')[0]!.slice('XSRF-TOKEN='.length))

    const response = await app.fetch(
      new Request('http://example.com/mutate', {
        method: 'POST',
        headers: {
          Cookie: xsrfCookie.split(';')[0]!,
          'X-XSRF-TOKEN': token,
        },
      }),
    )

    expect(response.status).toBe(200)
    expect(mutated()).toBe(true)
  })

  it('issues the XSRF-TOKEN cookie readable by JavaScript (intentionally not HttpOnly)', async () => {
    const { app } = await bootAuthApp()

    const response = await app.fetch(new Request('http://example.com/login-form'))
    const xsrfCookie = response.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith('XSRF-TOKEN='))

    expect(xsrfCookie).toBeDefined()
    // Axios/fetch clients must read this cookie to echo it as X-XSRF-TOKEN.
    expect(xsrfCookie!).not.toMatch(/HttpOnly/i)
  })

  it('session cookie defaults to HttpOnly + SameSite=Lax, Secure only in production', async () => {
    const { app } = await bootAuthApp()

    const response = await app.fetch(new Request('http://example.com/remember'))
    const sessionCookie = response.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith('guren.session='))

    expect(sessionCookie).toBeDefined()
    expect(sessionCookie!).toMatch(/HttpOnly/i)
    expect(sessionCookie!).toMatch(/SameSite=Lax/i)
    expect(sessionCookie!).not.toMatch(/;\s*Secure/i)
  })

  it('ignores the X-Testing-User header unless GUREN_TESTING is set', async () => {
    await withEnv({ GUREN_TESTING: undefined }, async () => {
      const app = new Application({ auth: {} })
      app.router.get('/private', () => 'secret', requireAuthenticated())
      await app.boot()

      const response = await app.fetch(
        new Request('http://example.com/private', { headers: { 'X-Testing-User': '1' } }),
      )

      expect(response.status).toBe(401)
    })
  })
})

describe('security posture: opt-in framework endpoints', () => {
  it('does not mount the MCP endpoint unless GUREN_MCP=1', async () => {
    await withEnv({ GUREN_MCP: undefined }, async () => {
      const app = await bootDefaultApp()
      const response = await app.fetch(
        new Request(`http://example.com${MCP_ENDPOINT_PATH}`, { method: 'POST' }),
      )

      expect(response.status).toBe(404)
    })
  })

  it('never mounts the MCP endpoint in production, even with GUREN_MCP=1', async () => {
    await withEnv({ GUREN_MCP: '1', NODE_ENV: 'production' }, async () => {
      const app = await bootDefaultApp()
      const response = await app.fetch(
        new Request(`http://example.com${MCP_ENDPOINT_PATH}`, { method: 'POST' }),
      )

      expect(response.status).toBe(404)
    })
  })
})
