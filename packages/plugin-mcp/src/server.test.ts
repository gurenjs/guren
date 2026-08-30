import { describe, test, expect } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Router, deriveAgentTools, type AgentToolDenialReason, type DerivedAgentTool } from '@guren/core'

import { AgentRateLimiter } from './rate-limit'
import { createAppMcpServer, type AppMcpServerOptions } from './server'
import type { ToolCallOutcome } from '@guren/core'

function deriveFixtureTools(): DerivedAgentTool[] {
  const router = new Router()
  const handler = () => new Response('ok')
  router.get('/posts', handler).name('posts.index').agent({ description: 'List posts' })
  router.post('/posts', handler).name('posts.store').agent({})
  router.get('/hidden', handler).name('hidden.index').agent({ expose: { mcp: false } })
  return deriveAgentTools(router.definitions()).tools.filter((tool) => tool.expose.mcp)
}

interface Recorded {
  invoked: Array<{ tool: string; status: number }>
  denied: Array<{ tool: string; reason: AgentToolDenialReason }>
}

async function connect(overrides: Partial<AppMcpServerOptions> = {}): Promise<{ client: Client; recorded: Recorded }> {
  const recorded: Recorded = { invoked: [], denied: [] }
  const server = createAppMcpServer({
    tools: deriveFixtureTools(),
    abilities: ['tools:*'],
    serverInfo: { name: 'test-app', version: '0.0.0' },
    rateKey: 'token-1',
    dispatch: async (): Promise<ToolCallOutcome> => ({
      content: [{ type: 'text', text: '{"ok":true}' }],
      status: 200,
    }),
    onInvoked: (tool, _args, status) => recorded.invoked.push({ tool: tool.toolName, status }),
    onDenied: (tool, _args, reason) => recorded.denied.push({ tool: tool.toolName, reason }),
    ...overrides,
  })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return { client, recorded }
}

describe('createAppMcpServer', () => {
  test('should list only the tools the abilities grant', async () => {
    const { client } = await connect({ abilities: ['tools:read'] })
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).toEqual(['posts.index'])
  })

  test('should advertise schema and annotations on listed tools', async () => {
    const { client } = await connect()
    const { tools } = await client.listTools()
    const index = tools.find((tool) => tool.name === 'posts.index')!
    expect(index.description).toBe('List posts')
    expect(index.inputSchema).toEqual({ type: 'object', properties: {} })
    expect(index.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    })
  })

  test('should dispatch a granted call and record the invocation', async () => {
    const { client, recorded } = await connect()
    const result = await client.callTool({ name: 'posts.store', arguments: {} })
    expect(result.isError).toBeUndefined()
    expect(recorded.invoked).toEqual([{ tool: 'posts.store', status: 200 }])
    expect(recorded.denied).toEqual([])
  })

  test('should deny an out-of-scope call as an error result and record it', async () => {
    const { client, recorded } = await connect({ abilities: ['tools:read'] })
    const result = await client.callTool({ name: 'posts.store', arguments: {} })
    expect(result.isError).toBe(true)
    expect(recorded.denied).toEqual([{ tool: 'posts.store', reason: 'scope' }])
    expect(recorded.invoked).toEqual([])
  })

  test('should refuse an unknown tool without recording anything', async () => {
    const { client, recorded } = await connect()
    const result = await client.callTool({ name: 'nope', arguments: {} })
    expect(result.isError).toBe(true)
    expect(recorded.invoked).toEqual([])
    expect(recorded.denied).toEqual([])
  })

  test('should not serve a tool excluded from the mcp surface', async () => {
    const { client } = await connect()
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).not.toContain('hidden.index')
    const result = await client.callTool({ name: 'hidden.index', arguments: {} })
    expect(result.isError).toBe(true)
  })

  test('should enforce the write budget through the limiter and record the denial', async () => {
    const limiter = new AgentRateLimiter({ max: 10, writeMax: 1, windowMs: 60_000 })
    const { client, recorded } = await connect({ limiter })
    await client.callTool({ name: 'posts.store', arguments: {} })
    const second = await client.callTool({ name: 'posts.store', arguments: {} })
    expect(second.isError).toBe(true)
    expect(recorded.denied).toEqual([{ tool: 'posts.store', reason: 'rate-limit' }])
  })

  test('should convert a dispatch throw into an error result recorded as a 500', async () => {
    const { client, recorded } = await connect({
      dispatch: async () => {
        throw new Error('boom')
      },
    })
    const result = await client.callTool({ name: 'posts.index', arguments: {} })
    expect(result.isError).toBe(true)
    expect(recorded.invoked).toEqual([{ tool: 'posts.index', status: 500 }])
  })
})
