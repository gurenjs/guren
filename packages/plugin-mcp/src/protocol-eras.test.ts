import { describe, test, expect, beforeAll } from 'bun:test'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { z } from 'zod'
import {
  EventServiceProvider,
  MemoryApiTokenStore,
  createApiToken,
  createApp,
  type Application,
  type Router,
} from '@guren/core'

import { mcpPlugin } from './plugin'
import { APP_MCP_REQUEST } from './server'

type ProtocolEra = 'modern' | 'legacy'

/**
 * The endpoint on both protocol eras (RFC 0028 §3). The SDK reaches the server
 * factory by a different path for each, and hands the legacy leg a clone of the
 * request, so per-request state has to survive both: these cases run every
 * property twice rather than trusting one era to stand in for the other.
 */
describe('mcpPlugin across protocol eras', () => {
  const store = new MemoryApiTokenStore()
  let app: Application
  let writer: string
  let reader: string

  function registerRoutes(router: Router): void {
    // Reports what the re-entrant request carried: the forwarded credential and
    // the `env` the inbound request was dispatched with.
    router
      .get('/whoami', (c) =>
        Response.json({
          authorization: c.req.header('Authorization') ?? null,
          tenant: (c.env as { TENANT?: string } | undefined)?.TENANT ?? null,
        }),
      )
      .name('whoami.show')
      .agent({ description: 'Echo the caller and tenant' })
    router
      .post('/posts', { body: z.object({ title: z.string() }) }, () => Response.json({ ok: true }))
      .name('posts.store')
      .agent({})
  }

  beforeAll(async () => {
    app = createApp({ routes: registerRoutes, providers: [EventServiceProvider, mcpPlugin({ rateLimit: false })] })
    app.auth.useTokens(store)
    await app.boot()

    writer = (await createApiToken(store, { name: 'writer', userId: 1, abilities: ['tools:*'] })).plainTextToken
    reader = (await createApiToken(store, { name: 'reader', userId: 2, abilities: ['tools:read'] })).plainTextToken
  })

  async function connect(era: ProtocolEra, bearer: string, tenant: string, bodies?: string[]): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
      fetch: async (input, init) => {
        const response = await app.fetch(new Request(input, init), { TENANT: tenant })
        bodies?.push(await response.clone().text())
        return response
      },
      requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
    })
    // A pin, not a preference: a server that only spoke 2025 would fail the
    // modern connection instead of negotiating down to it.
    const client = new Client(
      { name: `eras-${era}`, version: '1.0.0' },
      era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
    )
    await client.connect(transport)
    return client
  }

  function firstText(result: { content: unknown }): string {
    const [first] = result.content as Array<{ text?: string }>
    return first?.text ?? ''
  }

  for (const era of ['modern', 'legacy'] as const) {
    describe(`${era} client`, () => {
      test('negotiates the era it asked for', async () => {
        const client = await connect(era, writer, 'acme')

        expect(client.getProtocolEra()).toBe(era)

        await client.close()
      })

      test('lists tools by the caller\'s scopes', async () => {
        const [write, read] = await Promise.all([connect(era, writer, 'acme'), connect(era, reader, 'acme')])

        const [writeTools, readTools] = await Promise.all([write.listTools(), read.listTools()])

        expect(writeTools.tools.map((tool) => tool.name)).toContain('posts.store')
        expect(readTools.tools.map((tool) => tool.name)).toContain('whoami.show')
        expect(readTools.tools.map((tool) => tool.name)).not.toContain('posts.store')

        await Promise.all([write.close(), read.close()])
      })

      test('keeps concurrent callers and their env apart', async () => {
        const callers = await Promise.all([
          connect(era, writer, 'acme').then((client) => ({ client, bearer: writer, tenant: 'acme' })),
          connect(era, reader, 'globex').then((client) => ({ client, bearer: reader, tenant: 'globex' })),
        ])

        const calls = Array.from({ length: 12 }, (_, index) => callers[index % 2]!)
        const answers = await Promise.all(
          calls.map(async (caller) => {
            const result = await caller.client.callTool({ name: 'whoami.show', arguments: {} })
            return { caller, seen: JSON.parse(firstText(result)) as { authorization: string; tenant: string } }
          }),
        )

        for (const { caller, seen } of answers) {
          expect(seen).toEqual({ authorization: `Bearer ${caller.bearer}`, tenant: caller.tenant })
        }

        await Promise.all(callers.map(({ client }) => client.close()))
      })

      // The per-request options ride to the server factory inside `authInfo`,
      // which request handlers can read; nothing of it may reach the client.
      test('never puts the in-process request state on the wire', async () => {
        const bodies: string[] = []
        const client = await connect(era, writer, 'acme', bodies)

        await client.listTools()
        await client.callTool({ name: 'whoami.show', arguments: {} })
        await client.callTool({ name: 'posts.store', arguments: {} })

        expect(bodies.length).toBeGreaterThan(0)
        for (const body of bodies) {
          expect(body).not.toContain(APP_MCP_REQUEST)
          expect(body).not.toContain('authInfo')
        }

        await client.close()
      })

      test('refuses a tool the caller\'s scopes do not reach', async () => {
        const client = await connect(era, reader, 'acme')

        const result = await client.callTool({ name: 'posts.store', arguments: { title: 'x' } })

        expect(result.isError).toBe(true)

        await client.close()
      })
    })
  }

  test('refuses a subscriptions/listen stream rather than holding it open', async () => {
    const response = await app.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${reader}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2026-07-28',
          'Mcp-Method': 'subscriptions/listen',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'subscriptions/listen',
          params: {
            notifications: { toolsListChanged: true },
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientInfo': { name: 'listen', version: '1.0.0' },
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
      }),
    )

    // A held stream never finishes, so reading the body to the end is the assertion.
    expect(await response.text()).toContain('Subscription limit reached')
  })

  test('answers a GET with 405, since there is no session stream to open', async () => {
    const response = await app.fetch(
      new Request('http://localhost/mcp', { method: 'GET', headers: { Authorization: `Bearer ${writer}` } }),
    )

    expect(response.status).toBe(405)
  })

  test('answers a non-JSON body with 415', async () => {
    const response = await app.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { Authorization: `Bearer ${writer}`, 'Content-Type': 'text/plain' },
        body: 'tools/list',
      }),
    )

    expect(response.status).toBe(415)
  })

  test('authenticates before the protocol answers anything', async () => {
    const response = await app.fetch(new Request('http://localhost/mcp', { method: 'GET' }))

    expect(response.status).toBe(401)
  })
})
