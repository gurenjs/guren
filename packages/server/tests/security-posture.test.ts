process.env.APP_KEY = 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

import { describe, expect, it } from 'bun:test'
import { withEnv } from './support/env'
import { Application, requireAuthenticated } from '../src'
import { getSessionFromContext } from '../src/http/middleware/session'
import { MCP_ENDPOINT_PATH } from '../src/mcp/endpoint'

/**
 * Locks the framework's secure DEFAULTS: what an app gets when the developer
 * configures nothing. Per-middleware files cover option behavior; this one covers
 * the wiring. A diff that fails or edits this file IS the security review trigger.
 */

async function bootDefaultApp(): Promise<Application> {
  const app = new Application()
  app.router.get('/probe', () => 'ok')
  await app.boot()
  return app
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

  it('host authorization is opt-in: a bare Application serves any Host header', async () => {
    // The framework cannot know the app's legitimate hosts, so scaffolded
    // templates opt in (create-app passes hostAuthorization) rather than the core
    // guessing. If host authorization ever becomes a default, this test must flip.
    const app = await bootDefaultApp()
    const response = await app.fetch(
      new Request('http://example.com/probe', { headers: { Host: 'evil.example' } }),
    )

    expect(response.status).toBe(200)
  })
})

describe('security posture: middleware registered before the app can get in front of it', () => {
  /**
   * Hono composes matched handlers in registration order, and real apps register
   * before `boot()`: the templates call `autoConfigureInertiaAssets()` at module
   * scope, mounting `/resources/js/*` before `bootstrap()` awaits `boot()`.
   */
  async function bootAppWithPreBootAssetRoutes(): Promise<Application> {
    const app = new Application({ hostAuthorization: { allowedHosts: ['localhost:*'] } })
    // Both registered directly on Hono before boot(), the way the asset pipeline
    // does. The JS route returns a raw Response; the CSS route uses the context.
    app.hono.get('/resources/js/app.js', () => new Response('console.log(1)'))
    app.hono.get('/resources/css/app.css', (ctx) => ctx.text('body{}'))
    await app.boot()
    return app
  }

  it('rejects a forged Host on a route registered before boot()', async () => {
    const app = await bootAppWithPreBootAssetRoutes()

    const response = await app.fetch(
      new Request('http://evil.com/resources/js/app.js', { headers: { Host: 'evil.com' } }),
    )

    expect(response.status).toBe(403)
  })

  it('sends the hardening headers on a route registered before boot()', async () => {
    const app = await bootAppWithPreBootAssetRoutes()

    const response = await app.fetch(new Request('http://localhost:3000/resources/css/app.css'))

    expect(response.status).toBe(200)
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(response.headers.get('X-Frame-Options')).toBe('SAMEORIGIN')
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

  it('session cookie defaults to HttpOnly + SameSite=Lax, without Secure outside production', async () => {
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

  it('marks both session and XSRF cookies Secure when booted in production', async () => {
    await withEnv({ NODE_ENV: 'production' }, async () => {
      const { app } = await bootAuthApp()

      const response = await app.fetch(new Request('http://example.com/remember'))
      const cookies = response.headers.getSetCookie()
      const sessionCookie = cookies.find((cookie) => cookie.startsWith('guren.session='))
      const xsrfCookie = cookies.find((cookie) => cookie.startsWith('XSRF-TOKEN='))

      expect(sessionCookie!).toMatch(/;\s*Secure/i)
      expect(xsrfCookie!).toMatch(/;\s*Secure/i)
    })
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

describe('security posture: cookieless-auth CSRF exemptions', () => {
  it('exempts nothing until something declares it', async () => {
    const app = await bootDefaultApp()

    expect(app.getCookielessAuthPaths().size).toBe(0)
  })

  it('reports every declaration, so a plugin cannot exempt a path unobserved', async () => {
    const app = new Application()
    app.declareCookielessAuthPath('/plugin-endpoint')
    await app.boot()

    expect([...app.getCookielessAuthPaths()]).toEqual(['/plugin-endpoint'])
  })

  /**
   * Mounted after boot, like the endpoint a plugin mounts from its own boot
   * hook: `AuthServiceProvider.register()` adds the CSRF middleware during
   * boot, and Hono only applies middleware registered before the route.
   */
  async function bootWithDeclaredEndpoint(): Promise<Application> {
    const app = new Application({ auth: {} })
    await app.boot()
    app.hono.post('/declared', () => new Response('ok'))
    app.hono.post('/undeclared', () => new Response('ok'))
    app.declareCookielessAuthPath('/declared')
    return app
  }

  it('carries a declaration through to the CSRF middleware an auth app mounts', async () => {
    const app = await bootWithDeclaredEndpoint()

    const response = await app.fetch(new Request('http://example.com/declared', { method: 'POST' }))

    expect(response.status).toBe(200)
  })

  it('leaves an undeclared neighbour verified, so the middleware really is mounted', async () => {
    const app = await bootWithDeclaredEndpoint()

    const response = await app.fetch(new Request('http://example.com/undeclared', { method: 'POST' }))

    expect(response.status).toBe(403)
  })

  it('keeps a declaration that collides with an application route out of the set', async () => {
    const app = new Application()
    app.router.post('/collides', () => 'ok')
    await app.mountRoutes()
    app.declareCookielessAuthPath('/collides')

    expect(app.getCookielessAuthPaths().size).toBe(0)
  })
})
