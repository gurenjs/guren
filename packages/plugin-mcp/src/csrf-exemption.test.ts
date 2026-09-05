process.env.APP_KEY = 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

import { describe, test, expect, beforeAll } from 'bun:test'
import {
  MemoryApiTokenStore,
  createApiToken,
  createApp,
  type Application,
  type Router,
} from '@guren/core'

import { mcpPlugin } from './plugin'

/**
 * An app with `auth` mounts session + CSRF middleware, which the integration
 * suite's `createApp({ routes, providers })` does not. Without that, a
 * token-less POST is answered by CSRF before the endpoint's own bearer check
 * and the refusal is reported as the wrong thing entirely.
 */
describe('mcpPlugin under session CSRF protection', () => {
  const store = new MemoryApiTokenStore()
  let app: Application
  let token: string

  function registerRoutes(router: Router): void {
    router
      .get('/posts', () => Response.json({ posts: [] }))
      .name('posts.index')
      .agent({ description: 'List posts' })
    router.post('/comments', () => Response.json({ ok: true })).name('comments.store')
  }

  beforeAll(async () => {
    app = createApp({
      auth: {},
      routes: registerRoutes,
      providers: [mcpPlugin()],
    })
    app.auth.useTokens(store)
    await app.boot()

    const issued = await createApiToken(store, {
      name: 'test',
      userId: 42,
      abilities: ['tools:*'],
    })
    token = issued.plainTextToken
  })

  test('answers 401 rather than a CSRF 403 when no bearer is presented', async () => {
    const res = await app.hono.request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })

    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: 'unauthorized' })
  })

  test('does not let the exemption stand in for authentication', async () => {
    // The browser attaches cookies to a cross-site POST; nothing it can send
    // satisfies either auth path, so skipping CSRF grants no access.
    const res = await app.hono.request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: 'guren_session=whatever' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })

    expect(res.status).toBe(401)
  })

  test('serves a bearer-authenticated call that also carries cookies', async () => {
    // Cookies on purpose: a bearer request *without* them is already exempt by
    // the framework-wide rule, so only this shape reaches the path exemption.
    const res = await app.hono.request('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
        Cookie: 'guren_session=whatever',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      }),
    })

    expect(res.status).toBe(200)
  })

  test('survives an app that supplies its own csrfOptions', async () => {
    // `AuthServiceProvider` spreads the app's `csrfOptions` over the
    // framework's, so the endpoint registry has to be passed outside that
    // object: inside it, setting any option at all would delete it.
    const owned = createApp({
      auth: { csrfOptions: { exclude: ['/webhooks'] } },
      routes: registerRoutes,
      providers: [mcpPlugin()],
    })
    owned.auth.useTokens(store)
    await owned.boot()

    const res = await owned.hono.request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })

    expect(res.status).toBe(401)
  })

  test('still rejects a token-less cookie-bearing POST to an ordinary route', async () => {
    const res = await app.hono.request('/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: 'guren_session=whatever' },
      body: JSON.stringify({ body: 'hi' }),
    })

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ message: 'CSRF token mismatch' })
  })
})
