import { describe, test, expect, beforeAll } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'
import {
  AgentToolInvoked,
  EventServiceProvider,
  MemoryApiTokenStore,
  createApiToken,
  createApp,
  type Application,
  type EventManager,
  type Router,
} from '@guren/core'

import { mcpPlugin } from './plugin'

/**
 * The endpoint end to end: a real Application with token auth and agent
 * routes, driven by the SDK's own client over streamable HTTP — the fetch is
 * bridged straight into `app.fetch`, so this covers the transport, the
 * bearer boundary, the scope gate, the dispatch re-entry, and the audit
 * emission in one pass.
 */
describe('mcpPlugin (integration)', () => {
  const store = new MemoryApiTokenStore()
  let app: Application
  let events: EventManager
  let token: string

  function registerRoutes(router: Router): void {
    router
      .get('/posts', () => Response.json({ posts: [{ id: 1, title: 'Hello' }] }))
      .name('posts.index')
      .agent({ description: 'List posts' })
    router
      .post('/posts', { body: z.object({ title: z.string(), password: z.string() }) }, ({ body }) =>
        Response.json({ created: body.title }, { status: 201 }))
      .name('posts.store')
      .agent({})
  }

  beforeAll(async () => {
    app = createApp({
      routes: registerRoutes,
      providers: [EventServiceProvider, mcpPlugin()],
    })
    app.auth.useTokens(store)
    await app.boot()
    events = app.container.make<EventManager>('events')

    const issued = await createApiToken(store, {
      name: 'test',
      userId: 42,
      abilities: ['tools:*'],
    })
    token = issued.plainTextToken
  })

  async function connectClient(bearer: string): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
      fetch: (input, init) => app.fetch(new Request(input, init)),
      requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
    })
    const client = new Client({ name: 'integration', version: '1.0.0' })
    await client.connect(transport)
    return client
  }

  test('should refuse a request without a bearer token', async () => {
    const response = await app.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
    )
    expect(response.status).toBe(401)
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer')
  })

  test('should list the app tools to a granted token', async () => {
    const client = await connectClient(token)
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual(['posts.index', 'posts.store'])
  })

  test('should execute a read tool through the app and return its JSON', async () => {
    const client = await connectClient(token)
    const result = await client.callTool({ name: 'posts.index', arguments: {} })
    expect(result.isError).toBeUndefined()
    const content = result.content as Array<{ type: string; text: string }>
    expect(JSON.parse(content[0]!.text)).toEqual({ posts: [{ id: 1, title: 'Hello' }] })
  })

  test('should execute a write tool and emit a redacted AgentToolInvoked', async () => {
    const seen: AgentToolInvoked[] = []
    events.on(AgentToolInvoked, (event) => {
      seen.push(event)
    })

    const client = await connectClient(token)
    const result = await client.callTool({
      name: 'posts.store',
      arguments: { title: 'New', password: 'hunter2' },
    })
    expect(result.isError).toBeUndefined()

    // Emission is fire-and-forget; give the microtask a beat.
    await new Promise((resolve) => setTimeout(resolve, 10))
    const invoked = seen.find((event) => event.tool === 'posts.store')
    expect(invoked).toBeDefined()
    expect(invoked!.principal).toEqual({ kind: 'user', id: 42, abilities: ['tools:*'] })
    expect(invoked!.arguments.title).toBe('New')
    expect(invoked!.arguments.password).toBe('[REDACTED]')
    expect(invoked!.status).toBe(201)
    expect(invoked!.surface).toBe('mcp')
  })

  test('should hide and deny tools outside the token scopes', async () => {
    const readOnly = await createApiToken(store, {
      name: 'ro',
      userId: 42,
      abilities: ['tools:read'],
    })
    const client = await connectClient(readOnly.plainTextToken)

    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).toEqual(['posts.index'])

    const result = await client.callTool({ name: 'posts.store', arguments: { title: 'x', password: 'y' } })
    expect(result.isError).toBe(true)
  })

  test('should treat the ApiToken default abilities as granting no tools', async () => {
    const legacy = await createApiToken(store, { name: 'legacy', userId: 42 })
    const client = await connectClient(legacy.plainTextToken)
    const { tools } = await client.listTools()
    expect(tools).toEqual([])
  })
})
