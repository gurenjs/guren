import { describe, test, expect, beforeAll, beforeEach } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
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

/**
 * `guren.preflight` against a real application (RFC 0016 §5.4): the SDK's own
 * client, the endpoint, the dispatch re-entry and the router's preflight seam,
 * with no stub in the path. `server.test.ts` pins the companion tool's own
 * rules; what only this can show is that the verdict describes what the
 * application would really have done.
 */
describe('guren.preflight (integration)', () => {
  const store = new MemoryApiTokenStore()
  /** Written by the handler, and by nothing else — the evidence of execution. */
  let written: string[] = []
  let app: Application
  let token: string

  function registerRoutes(router: Router): void {
    router
      .post(
        '/posts',
        {
          body: z.object({ title: z.string().min(1) }),
          output: z.object({ created: z.string() }),
        },
        ({ body }) => {
          written.push(body.title)
          return { created: body.title }
        },
      )
      .name('posts.store')
      // No authorization middleware on the chain, which is what makes the seam
      // report `unverified: ['authorization']` — a route may authorize inside
      // its action, which a seam stopping before the handler cannot see.
      .agent({})
  }

  beforeAll(async () => {
    app = createApp({ routes: registerRoutes, providers: [EventServiceProvider, mcpPlugin()] })
    app.auth.useTokens(store)
    await app.boot()

    const issued = await createApiToken(store, { name: 'test', userId: 42, abilities: ['tools:*'] })
    token = issued.plainTextToken
  })

  beforeEach(() => {
    written = []
  })

  async function connectClient(): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
      fetch: (input, init) => app.fetch(new Request(input, init)),
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    })
    const client = new Client({ name: 'integration', version: '1.0.0' })
    await client.connect(transport)
    // Always before a call, so the SDK validates every result against the
    // advertised output schema instead of ignoring it.
    await client.listTools()
    return client
  }

  test('should answer an allowed verdict and leave no write behind', async () => {
    const client = await connectClient()
    const result = await client.callTool({
      name: 'guren.preflight',
      arguments: { tool: 'posts.store', input: { title: 'Hello' } },
    })

    expect(result.isError).toBeUndefined()
    const verdict = result.structuredContent as {
      tool: string
      allowed: boolean
      status: number
      validated: string[]
      unverified: string[]
    }
    expect(verdict.tool).toBe('posts.store')
    expect(verdict.allowed).toBe(true)
    expect(verdict.status).toBe(200)
    expect(verdict.validated).toContain('body')
    expect(verdict.unverified).toEqual(['authorization'])

    // The whole point: the seam stopped before the handler.
    expect(written).toEqual([])
  })

  // Without this, the assertion above passes for a route that cannot write at
  // all, and would keep passing if the handler were never reachable.
  test('should write when the same tool is really called', async () => {
    const client = await connectClient()
    const result = await client.callTool({
      name: 'posts.store',
      arguments: { title: 'Hello' },
    })

    expect(result.isError).toBeUndefined()
    expect(written).toEqual(['Hello'])
  })

  test('should report a validation failure as a success result carrying the errors', async () => {
    const client = await connectClient()
    const result = await client.callTool({
      name: 'guren.preflight',
      arguments: { tool: 'posts.store', input: { title: '' } },
    })

    // A refusal is an answer to the question asked, so the call itself
    // succeeded — the SDK would reject a plain-content success here, which is
    // why the verdict has an output schema of its own.
    expect(result.isError).toBeUndefined()
    const verdict = result.structuredContent as {
      allowed: boolean
      status: number
      errors: Record<string, string[]>
    }
    expect(verdict.allowed).toBe(false)
    expect(verdict.status).toBe(422)
    expect(verdict.errors.title).toBeDefined()
    expect(written).toEqual([])
  })

  test('should refuse a tool this app does not expose', async () => {
    const client = await connectClient()
    const result = await client.callTool({
      name: 'guren.preflight',
      arguments: { tool: 'posts.destroy' },
    })

    expect(result.isError).toBe(true)
    expect((result.content as Array<{ text: string }>)[0]!.text).toContain('posts.destroy')
  })
})
