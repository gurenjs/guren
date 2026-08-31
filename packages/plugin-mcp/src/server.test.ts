import { describe, test, expect } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  Router,
  deriveAgentTools,
  mapToolResponse,
  type AgentToolDenialReason,
  type DerivedAgentTool,
  type ToolCallOutcome,
} from '@guren/core'

import { AgentRateLimiter } from './rate-limit'
import { createAppMcpServer, type AppMcpServerOptions } from './server'

function deriveFixtureTools(): DerivedAgentTool[] {
  const router = new Router()
  const handler = () => new Response('ok')
  router.get('/posts', handler).name('posts.index').agent({ description: 'List posts' })
  router.post('/posts', handler).name('posts.store').agent({})
  router.get('/hidden', handler).name('hidden.index').agent({ expose: { mcp: false } })
  // Uncallable until the approval queue ships, and therefore unlisted — but
  // still checkable, which is what the preflight cases below turn on.
  router.post('/approvals', handler).name('approvals.store').agent({ approval: 'required' })
  return deriveAgentTools(router.definitions()).tools.filter((tool) => tool.expose.mcp)
}

interface Recorded {
  invoked: Array<{ tool: string; status: number; args: Record<string, unknown> }>
  denied: Array<{ tool: string; reason: AgentToolDenialReason; args: Record<string, unknown> }>
}

/**
 * The verdict header, by name.
 *
 * Written out rather than imported: the constant is internal to
 * `@guren/server` on purpose, and widening its export surface for a fixture
 * would be the wrong trade. Spelling it here is safe in the direction that
 * matters — the seam and `mapToolResponse` share the real constant, so a
 * rename moves both together and leaves this string classifying nothing,
 * which turns every case below red. It cannot quietly keep passing.
 */
const VERDICT_HEADER = 'X-Guren-Agent-Preflight-Verdict'

/**
 * What the router's preflight seam answers for an allowed rehearsal.
 *
 * Built by handing a real `Response` — carrying the real verdict header — to
 * the real `mapToolResponse`, rather than by writing the resulting outcome
 * out by hand. What marks an outcome as a verdict is a decision that module
 * owns, and a fixture that stated the answer itself would keep passing after
 * that decision changed. These cases are still about the companion tool's own
 * rules; the seam is driven end to end in `preflight.test.ts`.
 */
async function seamVerdict(
  tool: DerivedAgentTool,
  overrides: Record<string, unknown> = {},
): Promise<ToolCallOutcome> {
  const response = new Response(
    JSON.stringify({
      preflight: true,
      allowed: true,
      route: 'posts.store',
      validated: ['body'],
      unverified: ['authorization'],
      message: 'Preflight only: the handler did not run.',
      ...overrides,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json', [VERDICT_HEADER]: '1' } },
  )
  return mapToolResponse(tool, response)
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
    onInvoked: (tool, args, status) => recorded.invoked.push({ tool: tool.toolName, status, args }),
    onDenied: (tool, args, reason) => recorded.denied.push({ tool: tool.toolName, reason, args }),
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
    // Plus the preflight companion, which any token granting a tool can use.
    expect(tools.map((tool) => tool.name)).toEqual(['posts.index', 'guren.preflight'])
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
    expect(recorded.invoked).toEqual([{ tool: 'posts.store', status: 200, args: {} }])
    expect(recorded.denied).toEqual([])
  })

  test('should deny an out-of-scope call as an error result and record it', async () => {
    const { client, recorded } = await connect({ abilities: ['tools:read'] })
    const result = await client.callTool({ name: 'posts.store', arguments: {} })
    expect(result.isError).toBe(true)
    expect(recorded.denied).toEqual([{ tool: 'posts.store', reason: 'scope', args: {} }])
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
    expect(recorded.denied).toEqual([{ tool: 'posts.store', reason: 'rate-limit', args: {} }])
  })

  test('should convert a dispatch throw into an error result recorded as a 500', async () => {
    const { client, recorded } = await connect({
      dispatch: async () => {
        throw new Error('boom')
      },
    })
    const result = await client.callTool({ name: 'posts.index', arguments: {} })
    expect(result.isError).toBe(true)
    expect(recorded.invoked).toEqual([{ tool: 'posts.index', status: 500, args: {} }])
  })
})

/**
 * The companion tool's own rules (RFC 0016 §5.4): what it advertises, what it
 * is allowed to check, and what it records. The verdict it reports is
 * whatever the seam answered, stubbed here — `preflight.test.ts` drives the
 * real one.
 */
describe('createAppMcpServer: guren.preflight', () => {
  async function connectPreflight(overrides: Partial<AppMcpServerOptions> = {}) {
    const dispatched: Array<{ tool: string; args: Record<string, unknown>; preflight: boolean }> = []
    const connected = await connect({
      dispatch: async (tool, args, options) => {
        dispatched.push({ tool: tool.toolName, args, preflight: Boolean(options?.preflight) })
        return options?.preflight
          ? await seamVerdict(tool, { route: tool.toolName })
          : { content: [{ type: 'text', text: '{"ok":true}' }], status: 200 }
      },
      ...overrides,
    })
    return { ...connected, dispatched }
  }

  test('should advertise itself as read-only and non-destructive', async () => {
    const { client } = await connectPreflight()
    const { tools } = await client.listTools()
    const preflight = tools.find((tool) => tool.name === 'guren.preflight')!

    expect(preflight.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    })
    expect(preflight.description).toContain('without performing it')
    expect(preflight.inputSchema.required).toEqual(['tool'])
    expect(preflight.outputSchema?.required).toEqual(['tool', 'allowed', 'status', 'message'])
  })

  // A token that can call nothing has nothing to rehearse, and listing the
  // companion to it would tell a caller with no access that agent tools exist.
  test('should omit itself from a catalogue that grants nothing', async () => {
    const { client } = await connectPreflight({ abilities: [] })
    const { tools } = await client.listTools()
    expect(tools).toEqual([])
  })

  test('should answer a verdict as a success result, not an error', async () => {
    const { client, dispatched } = await connectPreflight()
    await client.listTools()
    const result = await client.callTool({
      name: 'guren.preflight',
      arguments: { tool: 'posts.store', input: { title: 'Hello' } },
    })

    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toEqual({
      tool: 'posts.store',
      allowed: true,
      status: 200,
      message: 'Preflight only: the handler did not run.',
      validated: ['body'],
      unverified: ['authorization'],
    })
    // The checked tool's own arguments went to the route, and the request
    // asked for a verdict rather than an execution.
    expect(dispatched).toEqual([
      { tool: 'posts.store', args: { title: 'Hello' }, preflight: true },
    ])
  })

  // The verdict the seam produced, carried through rather than rebuilt: a
  // route with no authorization middleware cannot be checked past the seam,
  // and the companion must not lose that half of the answer.
  test('should carry the seam\'s unverified list through unchanged', async () => {
    const { client } = await connectPreflight({
      dispatch: async (tool) => seamVerdict(tool, { unverified: [], validated: [] }),
    })
    const result = await client.callTool({
      name: 'guren.preflight',
      arguments: { tool: 'posts.index' },
    })
    expect((result.structuredContent as { unverified: string[] }).unverified).toEqual([])
  })

  test('should report a refusal as a success result carrying the errors', async () => {
    const { client } = await connectPreflight({
      dispatch: async () => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              message: 'The given data was invalid.',
              errors: { title: ['Required'] },
            }),
          },
        ],
        isError: true,
        status: 422,
      }),
    })
    const result = await client.callTool({ name: 'guren.preflight', arguments: { tool: 'posts.store' } })

    // The *call to the companion* succeeded; what it reports is a refusal.
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toEqual({
      tool: 'posts.store',
      allowed: false,
      status: 422,
      message: 'The given data was invalid.',
      errors: { title: ['Required'] },
    })
  })

  test('should deny a check of a tool the scopes do not grant', async () => {
    const { client, recorded, dispatched } = await connectPreflight({ abilities: ['tools:read'] })
    const result = await client.callTool({
      name: 'guren.preflight',
      arguments: { tool: 'posts.store', input: { title: 'Hello' } },
    })

    expect(result.isError).toBe(true)
    // Recorded as the rehearsal it was, not as an attempted call to
    // `posts.store`: an operator reading the trail must not be shown a refused
    // check where a refused write would be. The probed tool is still there, in
    // the arguments.
    expect(recorded.denied).toEqual([
      {
        tool: 'guren.preflight',
        reason: 'scope',
        args: { tool: 'posts.store', input: { title: 'Hello' } },
      },
    ])
    expect(recorded.invoked).toEqual([])
    expect(dispatched).toEqual([])
  })

  test('should keep a route claiming the reserved name out of the catalogue', async () => {
    // `guren check` fails an app that does this, but the endpoint must not
    // depend on the check having been run: two tools sharing one name makes an
    // MCP client reject the *entire* catalogue, so one bad route would take
    // every other tool down with it. The runtime filter is the backstop, and
    // without a case here it can be deleted with every test still green.
    const router = new Router()
    router.get('/posts', () => new Response('ok')).name('posts.index').agent({})
    router.post('/impostor', () => new Response('ok')).name('guren.preflight').agent({})
    const tools = deriveAgentTools(router.definitions()).tools.filter((tool) => tool.expose.mcp)

    const { client } = await connectPreflight({ tools })
    const listed = await client.listTools()

    const claimed = listed.tools.filter((tool) => tool.name === 'guren.preflight')
    expect(claimed).toHaveLength(1)
    // The companion's schema, not the route's: the survivor has to be the one
    // that answers preflight calls.
    expect(claimed[0]!.inputSchema.required).toEqual(['tool'])
    expect(listed.tools.map((tool) => tool.name)).toEqual(['posts.index', 'guren.preflight'])
  })

  test('should refuse an unknown tool name and name it', async () => {
    const { client, recorded } = await connectPreflight()
    const result = await client.callTool({ name: 'guren.preflight', arguments: { tool: 'nope' } })

    expect(result.isError).toBe(true)
    expect((result.content as Array<{ text: string }>)[0]!.text).toContain('"nope"')
    expect(recorded.denied).toEqual([])
    expect(recorded.invoked).toEqual([])
  })

  test('should refuse arguments that name no tool', async () => {
    const { client } = await connectPreflight()
    const result = await client.callTool({ name: 'guren.preflight', arguments: {} })
    expect(result.isError).toBe(true)
    expect((result.content as Array<{ text: string }>)[0]!.text).toContain('"tool" argument')
  })

  // An approval-gated tool is uncallable and therefore unlisted, which is
  // exactly the case where "would this be accepted?" is worth asking.
  test('should answer for a tool that requires approval', async () => {
    const { client, dispatched } = await connectPreflight()
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).not.toContain('approvals.store')

    const result = await client.callTool({
      name: 'guren.preflight',
      arguments: { tool: 'approvals.store' },
    })
    expect(result.isError).toBeUndefined()
    expect((result.structuredContent as { allowed: boolean }).allowed).toBe(true)
    expect(dispatched).toEqual([{ tool: 'approvals.store', args: {}, preflight: true }])
  })

  test('should record the invocation under the meta-tool name only', async () => {
    const { client, recorded } = await connectPreflight()
    await client.callTool({
      name: 'guren.preflight',
      arguments: { tool: 'posts.store', input: { title: 'Hello' } },
    })

    expect(recorded.invoked).toEqual([
      {
        tool: 'guren.preflight',
        status: 200,
        args: { tool: 'posts.store', input: { title: 'Hello' } },
      },
    ])
  })

  // A rehearsal that ran is not a rehearsal. Reporting the handler's own
  // answer as `allowed: true` would describe a write that happened as one
  // that did not.
  test('should error rather than report a verdict when the app ran the call', async () => {
    const { client } = await connectPreflight({
      dispatch: async () => ({ content: [{ type: 'text', text: '{"created":1}' }], status: 201 }),
    })
    const result = await client.callTool({ name: 'guren.preflight', arguments: { tool: 'posts.store' } })

    expect(result.isError).toBe(true)
    expect((result.content as Array<{ text: string }>)[0]!.text).toContain('its handler ran')
    expect(result.structuredContent).toBeUndefined()
  })
})
