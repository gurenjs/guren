import { describe, test, expect, beforeAll } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'
import {
  AgentToolDenied,
  AgentToolInvoked,
  EventServiceProvider,
  MemoryApiTokenStore,
  createApiToken,
  createApp,
  type Application,
  type EventManager,
  type Router,
} from '@guren/core'

import { presentExternalMcpAuth, type ExternalMcpAuth } from './external-auth'
import { mcpPlugin } from './plugin'

/**
 * The endpoint reached over the external-auth seam — the surface an
 * OAuth-fronted Workers deployment presents (RFC 0016 §7).
 *
 * Every case here drives the *real* endpoint through `app.fetch`, because the
 * property under test is precisely that the seam survives the trip: the
 * registration is keyed on the `Request` object identity, and anything between
 * the presentation and `readExternalMcpAuth` that rebuilt the request would
 * break it silently. A unit test of the map alone cannot see that.
 */
function registerRoutes(router: Router): void {
  router
    .get('/posts', () => Response.json({ posts: [{ id: 1 }] }))
    .name('posts.index')
    .agent({ description: 'List posts' })
  router
    .post('/posts', { body: z.object({ title: z.string(), ssn: z.string() }) }, () =>
      Response.json({ ok: true }),
    )
    .name('posts.store')
    .agent({ redact: ['ssn'] })
  // Reports the `Authorization` the *re-entrant* request carried, which is
  // the only way to observe what `buildToolRequest` was handed.
  router
    .get('/echo-auth', (c) => Response.json({ authorization: c.req.header('Authorization') ?? null }))
    .name('echo.auth')
    .agent({ description: 'Echo the forwarded Authorization header' })
}

function seamAuth(scopes: string[]): ExternalMcpAuth {
  return {
    principal: { kind: 'user', id: 'u_99', abilities: scopes },
    scopes,
  }
}

function jsonRpc(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

/** A client whose every request is presented over the seam before dispatch. */
function seamClient(app: Application, auth: ExternalMcpAuth): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
    fetch: (input, init) => app.fetch(presentExternalMcpAuth(new Request(input, init), auth)),
  })
  const client = new Client({ name: 'seam', version: '1.0.0' })
  return client.connect(transport).then(() => client)
}

/**
 * An app with **no token store at all** — the shape an OAuth-fronted
 * deployment has, and the one that answers 500 on the bearer path. Every seam
 * case runs against it so that a seam request reaching the store would fail
 * loudly rather than pass by accident.
 */
describe('mcpPlugin external auth (no token store configured)', () => {
  let app: Application
  let events: EventManager

  beforeAll(async () => {
    app = createApp({
      routes: registerRoutes,
      providers: [EventServiceProvider, mcpPlugin({ auth: 'external' })],
    })
    await app.boot()
    events = app.container.make<EventManager>('events')
  })

  test('should serve a seam-authenticated request without any token store', async () => {
    const client = await seamClient(app, seamAuth(['tools:*']))
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'echo.auth',
      'guren.preflight',
      'posts.index',
      'posts.store',
    ])
  })

  test('should honour the seam scopes as the scope gate input', async () => {
    const client = await seamClient(app, seamAuth(['tools:read']))
    const { tools } = await client.listTools()
    // `posts.store` is not read-only, so `tools:read` does not reach it.
    expect(tools.map((tool) => tool.name)).toContain('posts.index')
    expect(tools.map((tool) => tool.name)).not.toContain('posts.store')
  })

  test('should dispatch a seam tool call through the app', async () => {
    const client = await seamClient(app, seamAuth(['tools:*']))
    const result = await client.callTool({ name: 'posts.index', arguments: {} })
    expect(result.isError).toBeUndefined()
    const content = result.content as Array<{ type: string; text: string }>
    expect(JSON.parse(content[0]!.text)).toEqual({ posts: [{ id: 1 }] })
  })

  test('should record the seam principal on AgentToolInvoked, redacted, surface mcp', async () => {
    const seen: AgentToolInvoked[] = []
    events.on(AgentToolInvoked, (event) => {
      seen.push(event)
    })

    const client = await seamClient(app, seamAuth(['tools:*']))
    await client.callTool({ name: 'posts.store', arguments: { title: 'x', ssn: '123-45' } })

    const event = seen.find((candidate) => candidate.tool === 'posts.store')
    expect(event?.principal).toEqual({ kind: 'user', id: 'u_99', abilities: ['tools:*'] })
    expect(event?.surface).toBe('mcp')
    expect((event?.arguments as Record<string, unknown>).ssn).not.toBe('123-45')
  })

  test('should record the seam principal on AgentToolDenied', async () => {
    const seen: AgentToolDenied[] = []
    events.on(AgentToolDenied, (event) => {
      seen.push(event)
    })

    const client = await seamClient(app, seamAuth(['tools:read']))
    const result = await client.callTool({ name: 'posts.store', arguments: { title: 'x', ssn: 'y' } })

    expect(result.isError).toBe(true)
    expect(seen.at(-1)?.principal).toEqual({
      kind: 'user',
      id: 'u_99',
      abilities: ['tools:read'],
    })
  })

  /**
   * The fail-closed half of `auth: 'external'`. A request that did not arrive
   * through the authenticating layer must be refused outright — never offered
   * the bearer path as a second way in, and never the 500 that would leak the
   * absence of a token store as a hint.
   */
  test('should refuse a request with no seam auth, never falling through to bearer', async () => {
    const response = await app.fetch(jsonRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
    expect(response.status).toBe(401)
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer')
  })

  test('should refuse a bearer-bearing request with no seam auth', async () => {
    const response = await app.fetch(
      jsonRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { Authorization: 'Bearer anything' }),
    )
    expect(response.status).toBe(401)
    expect(await response.text()).toContain('external')
  })

  /**
   * The seam carries no credential the *application* can verify, so nothing
   * is forwarded: the inbound bearer belongs to the authority in front of the
   * app (the OAuth provider), which the app's own token guard has never seen.
   * Forwarding it would hand the app an unverifiable credential and put an
   * unrelated authority's secret wherever the app puts that header.
   */
  test('should forward no Authorization into the dispatched request', async () => {
    const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
      fetch: (input, init) =>
        app.fetch(presentExternalMcpAuth(new Request(input, init), seamAuth(['tools:*']))),
      requestInit: { headers: { Authorization: 'Bearer provider-issued-token' } },
    })
    const client = new Client({ name: 'echo', version: '1.0.0' })
    await client.connect(transport)

    const result = await client.callTool({ name: 'echo.auth', arguments: {} })
    const content = result.content as Array<{ type: string; text: string }>
    expect(JSON.parse(content[0]!.text)).toEqual({ authorization: null })
  })

  /**
   * The per-caller rate limiter has no token id to key on over the seam, so
   * the key is derived from the principal. Two properties, and both need
   * asserting because each alone survives the wrong implementation: a key that
   * is simply absent still limits (every caller lands in one shared bucket),
   * and a key that is a constant limits too — it just limits *everyone* the
   * moment one caller is noisy.
   */
  test('should rate-limit a seam caller, per principal', async () => {
    const limited = createApp({
      routes: registerRoutes,
      providers: [mcpPlugin({ auth: 'external', rateLimit: { max: 2, writeMax: 2 } })],
    })
    await limited.boot()

    const alice = await seamClient(limited, {
      principal: { kind: 'user', id: 'alice', abilities: ['tools:*'] },
      scopes: ['tools:*'],
    })
    // connect() spends nothing; each callTool spends one.
    await alice.callTool({ name: 'posts.index', arguments: {} })
    await alice.callTool({ name: 'posts.index', arguments: {} })
    const exhausted = await alice.callTool({ name: 'posts.index', arguments: {} })

    expect(exhausted.isError).toBe(true)
    const content = exhausted.content as Array<{ type: string; text: string }>
    expect(content[0]!.text.toLowerCase()).toContain('rate limit')

    // A different principal has its own budget — the half a constant key
    // would fail.
    const bob = await seamClient(limited, {
      principal: { kind: 'user', id: 'bob', abilities: ['tools:*'] },
      scopes: ['tools:*'],
    })
    expect((await bob.callTool({ name: 'posts.index', arguments: {} })).isError).toBeUndefined()
  })

  test('should refuse a request rebuilt from a presented one', async () => {
    const presented = presentExternalMcpAuth(
      jsonRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      seamAuth(['tools:*']),
    )

    const response = await app.fetch(new Request(presented))
    expect(response.status).toBe(401)
  })
})

/**
 * The default configuration: the seam is honoured when presented, and every
 * other request takes the bearer path exactly as before. This is the
 * regression half — an app that never presents the seam must be unable to tell
 * this release from the last.
 */
describe('mcpPlugin external auth (default config, token store present)', () => {
  const store = new MemoryApiTokenStore()
  let app: Application
  let token: string

  beforeAll(async () => {
    app = createApp({
      routes: registerRoutes,
      providers: [EventServiceProvider, mcpPlugin()],
    })
    app.auth.useTokens(store)
    await app.boot()

    const issued = await createApiToken(store, { name: 't', userId: 1, abilities: ['tools:*'] })
    token = issued.plainTextToken
  })

  test('should still verify a bearer when no seam auth is presented', async () => {
    const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
      fetch: (input, init) => app.fetch(new Request(input, init)),
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    })
    const client = new Client({ name: 'bearer', version: '1.0.0' })
    await client.connect(transport)

    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('posts.index')
  })

  test('should still refuse an invalid bearer with no seam auth', async () => {
    const response = await app.fetch(
      jsonRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { Authorization: 'Bearer nope' }),
    )
    expect(response.status).toBe(401)
    expect(await response.text()).toContain('invalid, expired, or revoked')
  })

  test('should honour a presented seam even under the default config', async () => {
    const client = await seamClient(app, seamAuth(['tools:read']))
    const names = (await client.listTools()).tools.map((tool) => tool.name)
    expect(names).toContain('posts.index')
    expect(names).not.toContain('posts.store')
  })

  /**
   * The seam wins over a bearer presented on the same request, and does so
   * *narrowing*: this token grants `tools:*`, the seam grants only
   * `tools:read`, and the endpoint must serve the seam's answer. Reading the
   * bearer first would silently widen every OAuth grant to whatever token
   * happened to ride along.
   */
  test('should prefer the seam over an Authorization header on the same request', async () => {
    const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
      fetch: (input, init) =>
        app.fetch(presentExternalMcpAuth(new Request(input, init), seamAuth(['tools:read']))),
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    })
    const client = new Client({ name: 'both', version: '1.0.0' })
    await client.connect(transport)

    expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain('posts.store')
  })
})
