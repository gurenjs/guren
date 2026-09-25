import { describe, test, expect, beforeAll } from 'bun:test'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import {
  EventServiceProvider,
  MemoryApiTokenStore,
  createApiToken,
  createApp,
  createForceHttpsMiddleware,
  type Application,
  type Router,
} from '@guren/core'

import { mcpPlugin } from './plugin'

/**
 * An app mounting force-https behind a TLS-terminating proxy: the proxy speaks
 * plain HTTP to the app and says `X-Forwarded-Proto: https`. The tool call
 * re-enters on the `/mcp` request's own `http://` origin without that header,
 * so a redirect there would reach the agent as a successful `HTTP 301`.
 */
describe('mcpPlugin behind force-https', () => {
  const store = new MemoryApiTokenStore()
  let app: Application
  let token: string

  beforeAll(async () => {
    app = createApp({
      routes: (router: Router) => {
        router
          .get('/posts', () => Response.json({ posts: [{ id: 1 }] }))
          .name('posts.index')
          .agent({ description: 'List posts' })
      },
      providers: [EventServiceProvider, mcpPlugin()],
    })
    app.use('*', createForceHttpsMiddleware())
    app.auth.useTokens(store)
    await app.boot()

    const issued = await createApiToken(store, { name: 'proxy', userId: 1, abilities: ['tools:*'] })
    token = issued.plainTextToken
  })

  async function connectThroughProxy(): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL('http://app.example/mcp'), {
      fetch: (input, init) => app.fetch(new Request(input, init)),
      requestInit: { headers: { Authorization: `Bearer ${token}`, 'X-Forwarded-Proto': 'https' } },
    })
    const client = new Client({ name: 'behind-proxy', version: '1.0.0' })
    await client.connect(transport)
    return client
  }

  test('should run the tool rather than answer the redirect force-https gives plain HTTP', async () => {
    const client = await connectThroughProxy()
    const result = await client.callTool({ name: 'posts.index', arguments: {} })

    const content = result.content as Array<{ type: string; text: string }>
    expect(content[0]!.text).not.toContain('301')
    expect(result.isError).toBeUndefined()
    expect(JSON.parse(content[0]!.text)).toEqual({ posts: [{ id: 1 }] })
  })

  test('should still redirect the MCP endpoint itself when it is reached over plain HTTP', async () => {
    const response = await app.fetch(
      new Request('http://app.example/mcp', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'X-Guren-Agent-Surface': 'mcp',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
    )
    expect(response.status).toBe(301)
    expect(response.headers.get('Location')).toBe('https://app.example/mcp')
  })

  test('should redirect a plain HTTP request to an agent route that claims to be a tool call', async () => {
    const response = await app.fetch(
      new Request('http://app.example/posts', {
        headers: { Accept: 'application/json', 'X-Guren-Agent-Surface': 'mcp' },
      }),
    )
    expect(response.status).toBe(301)
    expect(response.headers.get('Location')).toBe('https://app.example/posts')
  })
})
