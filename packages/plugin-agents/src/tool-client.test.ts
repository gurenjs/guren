// Set before anything imports @guren/core: the fixture mounts CSRF middleware,
// which needs a signing key.
process.env.APP_KEY = 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

import { describe, test, expect, beforeAll, afterEach } from 'bun:test'
import { z } from 'zod'
import {
  AUTH_CONTEXT_KEY,
  AgentToolDenied,
  AgentToolInvoked,
  EventServiceProvider,
  createApp,
  createCsrfMiddleware,
  requireAuthenticated,
  type AgentApprovalMatch,
  type AgentApprovalRequest,
  type AgentApprovalStore,
  type Application,
  type AuthContext,
  type EventManager,
  type Router,
} from '@guren/core'

import { agentsPlugin } from './plugin'
import { resolveAgentRuntime, type AgentRuntime } from './latch'
import { createAgentToolClient } from './tool-client'

/**
 * The durable tool client against a real application (RFC 0017 §4), driveable
 * on Bun with no Durable Object: workerd covers the shell, this covers every
 * gate. The fixture mounts `createCsrfMiddleware` on purpose — a durable call
 * is cookie-less, so without the seam exemption a mutating case 419s.
 */

const NOW = new Date('2026-09-03T12:00:00.000Z')

/** An array with a compare-and-set `consume`, and no cleverness beyond that. */
class MemoryApprovalStore implements AgentApprovalStore {
  readonly records: AgentApprovalRequest[] = []

  async create(request: AgentApprovalRequest): Promise<void> {
    this.records.push(request)
  }

  async find(id: string): Promise<AgentApprovalRequest | null> {
    return this.records.find((record) => record.id === id) ?? null
  }

  async findMatch(match: AgentApprovalMatch): Promise<AgentApprovalRequest | null> {
    const matched = this.records.filter(
      (record) =>
        record.tool === match.tool
        && record.fingerprint === match.fingerprint
        && record.principalKey === match.principalKey
        && record.consumedAt === undefined,
    )
    return matched[matched.length - 1] ?? null
  }

  async consume(id: string): Promise<boolean> {
    const record = this.records.find((candidate) => candidate.id === id)
    if (!record || record.consumedAt !== undefined) return false
    record.consumedAt = NOW.toISOString()
    return true
  }
}

function registerRoutes(router: Router): void {
  router.middleware(requireAuthenticated()).group((guarded) => {
    guarded
      .get('/me', async (c) => {
        const auth = c.get(AUTH_CONTEXT_KEY) as AuthContext | undefined
        return Response.json({ user: (await auth?.user()) ?? null })
      })
      .name('echo.me')
      .agent({ description: 'Report the authenticated caller' })
  })

  router
    .get('/posts', () => Response.json({ posts: [{ id: 1 }] }))
    .name('posts.index')
    .agent({ description: 'List posts' })

  router
    .post('/posts', { body: z.object({ title: z.string() }) }, ({ body }) =>
      Response.json({ created: body.title }))
    .name('posts.store')
    .agent({ description: 'Create a post' })

  router
    .post('/posts/:id/publish', { params: z.object({ id: z.coerce.number() }) }, ({ params }) =>
      Response.json({ published: params.id }))
    .name('posts.publish')
    .agent({ description: 'Publish a post', approval: 'required' })
}

const store = new MemoryApprovalStore()

let app: Application
let events: EventManager
let runtime: AgentRuntime
let records: Array<AgentToolInvoked | AgentToolDenied>

beforeAll(async () => {
  app = createApp({
    routes: registerRoutes,
    providers: [
      EventServiceProvider,
      agentsPlugin({
        agents: {
          triager: {
            module: 'app/Agents/Triager.ts',
            export: 'Triager',
            // Exactly the two tools the "allowed" cases use, so anything else
            // being reachable is a scope-gate failure rather than a fixture
            // that granted too much.
            scopes: ['tool:posts.index', 'tool:echo.me', 'tool:posts.publish'],
          },
          writer: {
            module: 'app/Agents/Writer.ts',
            export: 'Writer',
            scopes: ['tool:posts.store'],
          },
          reader: {
            module: 'app/Agents/Reader.ts',
            export: 'Reader',
            scopes: ['tools:read'],
          },
          thrifty: {
            module: 'app/Agents/Thrifty.ts',
            export: 'Thrifty',
            scopes: ['tool:posts.index'],
            budget: { callsPerMinute: 2 },
          },
        },
        approvals: {
          store,
          notify: () => {},
        },
      }),
    ],
  })
  // Mounted before boot so it sits in front of every route below. Apps get it
  // from `AuthServiceProvider` when they configure auth; this fixture
  // configures none, so it mounts the same middleware by hand.
  app.use('*', createCsrfMiddleware())
  await app.boot()
  events = app.container.make<EventManager>('events')
  runtime = await resolveAgentRuntime()

  records = []
  events.on(AgentToolInvoked, (event) => {
    records.push(event)
  })
  events.on(AgentToolDenied, (event) => {
    records.push(event)
  })
})

afterEach(() => {
  records.length = 0
})

/** Wait for the emitter's fire-and-forget listener dispatch to settle. */
async function drainEvents(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function client(agentName: string, instanceId: string, now?: () => number) {
  return createAgentToolClient({ runtime, agentName, instanceId, ...(now ? { now } : {}) })
}

describe('createAgentToolClient: the allowed path', () => {
  test('should execute a granted read tool', async () => {
    const result = await client('triager', 'inbox-1').call('posts.index', {})
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.outcome.status).toBe(200)
    expect(result.outcome.isError).toBeUndefined()
  })

  test('should authenticate the route as the per-instance service principal', async () => {
    // The seam, end to end: `requireAuthenticated()` passes and the app's own
    // auth context resolves the principal the client minted. Without the
    // handoff this route answers 401 and the assertion below fails.
    const result = await client('triager', 'inbox-1').call('echo.me', {})
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.outcome.status).toBe(200)
    expect(JSON.parse(textOf(result.outcome))).toEqual({ user: { id: 'agent:triager:inbox-1' } })
  })

  test('should pass CSRF on a mutating call, which carries no cookie and no token', async () => {
    const result = await client('writer', 'w-1').call('posts.store', { title: 'Hello' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // A 419 here would be the CSRF middleware, not the app: the fixture mounts
    // it, and a durable request has neither a cookie nor an XSRF token.
    expect(result.outcome.status).toBe(200)
    expect(JSON.parse(textOf(result.outcome))).toEqual({ created: 'Hello' })
  })

  test('should audit an execution under the durable surface and the instance principal', async () => {
    await client('triager', 'inbox-7').call('posts.index', {})
    await drainEvents()

    const invoked = records.filter((event): event is AgentToolInvoked => event instanceof AgentToolInvoked)
    expect(invoked).toHaveLength(1)
    expect(invoked[0]!.surface).toBe('durable')
    expect(invoked[0]!.tool).toBe('posts.index')
    expect(invoked[0]!.principal).toEqual({
      kind: 'service',
      id: 'agent:triager:inbox-7',
      abilities: ['tool:echo.me', 'tool:posts.index', 'tool:posts.publish'],
    })
  })

  test('should give colliding agent/instance pairs distinct principal ids', async () => {
    // `agent:a:b:c` is ambiguous: it could be name "a" + instance "b:c", or
    // name "a:b" + instance "c". The name half is constrained by
    // AGENT_NAME_PATTERN and the instance half — which comes from the Durable
    // Object, not from config — is percent-encoded, so the two cannot meet.
    await client('triager', 'inbox:1').call('posts.index', {})
    await client('triager', 'inbox%3A1').call('posts.index', {})
    await drainEvents()

    const ids = records.map((event) => event.principal?.id)
    expect(new Set(ids).size).toBe(2)
    expect(ids[0]).toBe('agent:triager:inbox%3A1')
    expect(ids[1]).toBe('agent:triager:inbox%253A1')
  })

  test('should key the audit principal per instance, not per agent class', async () => {
    await client('triager', 'inbox-a').call('posts.index', {})
    await client('triager', 'inbox-b').call('posts.index', {})
    await drainEvents()

    expect(records.map((event) => event.principal?.id)).toEqual([
      'agent:triager:inbox-a',
      'agent:triager:inbox-b',
    ])
  })
})

describe('createAgentToolClient: the scope gate', () => {
  test('should deny a tool outside the registration scopes', async () => {
    const result = await client('triager', 'inbox-1').call('posts.store', { title: 'nope' })
    expect(result.denied).toBe(true)
    if (!result.denied) return
    expect(result.reason).toBe('scope')
  })

  test('should audit the denial under the durable surface', async () => {
    await client('triager', 'inbox-1').call('posts.store', { title: 'nope' })
    await drainEvents()

    const denied = records.filter((event): event is AgentToolDenied => event instanceof AgentToolDenied)
    expect(denied).toHaveLength(1)
    expect(denied[0]!.reason).toBe('scope')
    expect(denied[0]!.surface).toBe('durable')
    expect(denied[0]!.tool).toBe('posts.store')
  })

  test('should expand tools:read to read-only tools only', async () => {
    const reader = client('reader', 'r-1')
    expect([...reader.allowed].sort()).toEqual(['echo.me', 'posts.index'])

    expect((await reader.call('posts.index', {})).ok).toBe(true)

    const denied = await reader.call('posts.store', { title: 'nope' })
    expect(denied.denied).toBe(true)
    if (!denied.denied) return
    expect(denied.reason).toBe('scope')
  })

  test('should throw rather than deny for a tool no route declares', async () => {
    // A typo is the agent author's bug, not a permission answer — reporting it
    // as a denial would send the reader to config/agents.ts instead of to the
    // line they mistyped.
    await expect(client('triager', 'inbox-1').call('posts.destroy', {})).rejects.toThrow(
      /No tool named "posts.destroy" exists/,
    )
  })

  test('should throw for an agent name no registration carries', () => {
    expect(() => client('ghost', 'g-1')).toThrow(/No agent named "ghost" is registered/)
  })
})

describe('createAgentToolClient: the approval gate', () => {
  test('should return a pending result carrying the request id', async () => {
    const result = await client('triager', 'inbox-1').call('posts.publish', { id: 1 })
    expect(result.pending).toBe(true)
    if (!result.pending) return
    expect(result.tool).toBe('posts.publish')
    expect(result.requestId).toBe(store.records.at(-1)!.id)
    expect(result.expiresAt).toBe(store.records.at(-1)!.expiresAt)
  })

  test('should skip the approval gate for a rehearsal', async () => {
    // Rehearsing an approval-gated tool is exactly what a caller most needs,
    // and a rehearsal executes nothing.
    const result = await client('triager', 'inbox-1').preflight('posts.publish', { id: 2 })
    expect(result.ok).toBe(true)
  })

  test('should fail closed with no queue configured', async () => {
    const unqueued: AgentRuntime = { ...runtime }
    delete unqueued.approvals
    const result = await createAgentToolClient({
      runtime: unqueued,
      agentName: 'triager',
      instanceId: 'inbox-1',
    }).call('posts.publish', { id: 3 })

    expect(result.denied).toBe(true)
    if (!result.denied) return
    expect(result.reason).toBe('approval')
    // The refusal names this surface's own configuration line, not the MCP
    // plugin's.
    expect(result.message).toContain('agentsPlugin({ approvals: { store, notify } })')
  })
})

describe('createAgentToolClient: the per-instance budget', () => {
  test('should deny the call past the window budget', async () => {
    let clock = 1_000_000
    const thrifty = client('thrifty', 't-1', () => clock)

    expect((await thrifty.call('posts.index', {})).ok).toBe(true)
    expect((await thrifty.call('posts.index', {})).ok).toBe(true)

    const denied = await thrifty.call('posts.index', {})
    expect(denied.denied).toBe(true)
    if (!denied.denied) return
    expect(denied.reason).toBe('rate-limit')
    expect(denied.message).toContain('callsPerMinute')
  })

  test('should let the window slide', async () => {
    let clock = 2_000_000
    const thrifty = client('thrifty', 't-2', () => clock)

    await thrifty.call('posts.index', {})
    await thrifty.call('posts.index', {})
    expect((await thrifty.call('posts.index', {})).denied).toBe(true)

    clock += 60_001
    expect((await thrifty.call('posts.index', {})).ok).toBe(true)
  })

  test('should meter each instance separately', async () => {
    let clock = 3_000_000
    const now = (): number => clock
    const first = client('thrifty', 't-3', now)
    const second = client('thrifty', 't-4', now)

    await first.call('posts.index', {})
    await first.call('posts.index', {})
    expect((await first.call('posts.index', {})).denied).toBe(true)
    expect((await second.call('posts.index', {})).ok).toBe(true)
  })

  test('should audit a budget denial as a rate-limit refusal', async () => {
    let clock = 4_000_000
    const thrifty = client('thrifty', 't-5', () => clock)
    await thrifty.call('posts.index', {})
    await thrifty.call('posts.index', {})
    records.length = 0

    await thrifty.call('posts.index', {})
    await drainEvents()

    const denied = records.filter((event): event is AgentToolDenied => event instanceof AgentToolDenied)
    expect(denied).toHaveLength(1)
    expect(denied[0]!.reason).toBe('rate-limit')
    expect(denied[0]!.surface).toBe('durable')
  })

  test('should default to 60 calls a minute for a registration that names none', async () => {
    let clock = 5_000_000
    const triager = client('triager', 'burst', () => clock)
    for (let call = 0; call < 60; call++) {
      expect((await triager.call('posts.index', {})).ok).toBe(true)
    }
    expect((await triager.call('posts.index', {})).denied).toBe(true)
  })
})

function textOf(outcome: { content: Array<{ type: string; text?: string }> }): string {
  return outcome.content.map((part) => part.text ?? '').join('')
}
