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
  createBearerTokenMiddleware,
  getApiToken,
  tokenCan,
  type AgentApprovalMatch,
  type AgentApprovalRequest,
  type AgentApprovalStore,
  type Application,
  type EventManager,
  type Router,
} from '@guren/core'

import { mcpPlugin } from './plugin'

/**
 * The endpoint end to end: a real Application with token auth and agent routes,
 * driven by the SDK's own client over streamable HTTP bridged into `app.fetch` —
 * transport, bearer boundary, scope gate, dispatch re-entry and audit emission
 * in one pass.
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
      .post(
        '/posts',
        {
          body: z.object({ title: z.string(), password: z.string() }),
          // An object `output` is what makes the SDK client validate a call's
          // structuredContent after listTools(), and the shape `guren check`
          // steers agent routes toward.
          output: z.object({ created: z.string() }),
        },
        // An output contract validates the returned data, so the handler
        // returns the payload rather than a Response.
        ({ body }) => ({ created: body.title }),
      )
      .name('posts.store')
      .agent({})
    // `ssn` on purpose, not `password`: the default fragment list masks anything
    // password-shaped whichever redact list is in play, so only a field the
    // defaults do not know can tell a dropped per-tool list apart.
    router
      .post(
        '/profiles',
        { body: z.object({ ssn: z.string(), title: z.string() }) },
        () => Response.json({ ok: true }),
      )
      .name('profiles.store')
      .agent({ redact: ['ssn'] })
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
    // The preflight companion rides alongside the app's own tools for any
    // token that grants at least one of them (RFC 0016 §5.4).
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'guren.preflight',
      'posts.index',
      'posts.store',
      'profiles.store',
    ])
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
    // listTools() first, so the SDK validates the call's structuredContent
    // against the advertised output schema instead of ignoring it.
    await client.listTools()
    const result = await client.callTool({
      name: 'posts.store',
      arguments: { title: 'New', password: 'hunter2' },
    })
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toEqual({ created: 'New' })

    // Emission is fire-and-forget; give the microtask a beat.
    await new Promise((resolve) => setTimeout(resolve, 10))
    const invoked = seen.find((event) => event.tool === 'posts.store')
    expect(invoked).toBeDefined()
    expect(invoked!.principal).toEqual({ kind: 'user', id: 42, abilities: ['tools:*'] })
    expect(invoked!.arguments.title).toBe('New')
    expect(invoked!.arguments.password).toBe('[REDACTED]')
    expect(invoked!.status).toBe(200)
    expect(invoked!.surface).toBe('mcp')
  })

  test('should redact a preflight through the checked tool\'s own redact list', async () => {
    // The record is a `guren.preflight` invocation, but the redaction rules that
    // apply are the *checked* tool's: the meta-tool declares none, and its empty
    // list would write a route's declared-secret field into the trail in clear.
    const seen: AgentToolInvoked[] = []
    events.on(AgentToolInvoked, (event) => {
      seen.push(event)
    })

    const client = await connectClient(token)
    await client.listTools()
    const result = await client.callTool({
      name: 'guren.preflight',
      arguments: { tool: 'profiles.store', input: { ssn: '123-45-6789', title: 'ok' } },
    })
    expect(result.isError).toBeUndefined()

    await new Promise((resolve) => setTimeout(resolve, 10))
    const invoked = seen.find((event) => event.tool === 'guren.preflight')
    expect(invoked).toBeDefined()
    const input = invoked!.arguments.input as Record<string, unknown>
    expect(input.ssn).toBe('[REDACTED]')
    // The rest survives: redaction that masked everything would pass this test
    // for the wrong reason.
    expect(input.title).toBe('ok')
  })

  test('should hide and deny tools outside the token scopes', async () => {
    const readOnly = await createApiToken(store, {
      name: 'ro',
      userId: 42,
      abilities: ['tools:read'],
    })
    const client = await connectClient(readOnly.plainTextToken)

    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).toEqual(['posts.index', 'guren.preflight'])

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

/**
 * The bearer path forwards the caller's own `Authorization` into the dispatched
 * request, and the application's own token machinery verifies it there — the
 * half RFC 0017's principal seam must **not** replace. The seam satisfies
 * `requireAuthenticated()`, `Controller.auth` and `Gate` but is no token, and
 * `createBearerTokenMiddleware`/`getApiToken(ctx)`/`tokenCan*` judge an `ApiToken`.
 */
describe('mcpPlugin bearer forwarding (integration)', () => {
  const tokens = new MemoryApiTokenStore()
  let app: Application
  let token: string

  beforeAll(async () => {
    app = createApp({
      routes: (router: Router) => {
        // Stop forwarding the header — or forward the principal instead — and
        // every route using them answers 401 while nothing else fails: the
        // scope gate and the audit trail carry on. Echoing the verified token
        // back out is the only evidence the header made the trip and was
        // accepted on the far side.
        router.middleware(createBearerTokenMiddleware({ store: tokens })).group((guarded) => {
          guarded
            .get('/token-echo', (c) => {
              const verified = getApiToken(c)
              return Response.json({
                tokenName: verified?.token.name ?? null,
                userId: verified?.userId ?? null,
                canCallTools: verified ? tokenCan({ abilities: verified.abilities }, 'tools:*') : false,
              })
            })
            .name('tokens.echo')
            .agent({ description: 'Echo the API token the app verified' })
        })
      },
      providers: [mcpPlugin()],
    })
    app.auth.useTokens(tokens)
    await app.boot()

    const issued = await createApiToken(tokens, {
      name: 'forwarded',
      userId: 99,
      abilities: ['tools:*'],
    })
    token = issued.plainTextToken
  })

  test('should execute a route behind the token middleware, which sees the token', async () => {
    const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
      fetch: (input, init) => app.fetch(new Request(input, init)),
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    })
    const client = new Client({ name: 'bearer-forwarding', version: '1.0.0' })
    await client.connect(transport)

    const result = await client.callTool({ name: 'tokens.echo', arguments: {} })

    expect(result.isError).toBeUndefined()
    const content = result.content as Array<{ type: string; text: string }>
    expect(JSON.parse(content[0]!.text)).toEqual({
      tokenName: 'forwarded',
      userId: 99,
      canCallTools: true,
    })
  })
})

/**
 * A store with no cleverness in it: an array, and a `consume` that is a
 * compare-and-set because the interface says one is required. Nothing here
 * filters expiry or status — that is the framework's job, and a fixture that
 * filtered would hide a gate that had stopped checking.
 */
class MemoryApprovalStore implements AgentApprovalStore {
  readonly records: AgentApprovalRequest[] = []

  async create(request: AgentApprovalRequest): Promise<void> {
    this.records.push(request)
  }

  async find(id: string): Promise<AgentApprovalRequest | null> {
    return this.records.find((record) => record.id === id) ?? null
  }

  async findMatch(match: AgentApprovalMatch): Promise<AgentApprovalRequest | null> {
    return (
      this.records.find(
        (record) =>
          record.tool === match.tool
          && record.fingerprint === match.fingerprint
          && record.principalKey === match.principalKey
          && record.consumedAt === undefined,
      ) ?? null
    )
  }

  async consume(id: string): Promise<boolean> {
    const record = this.records.find((candidate) => candidate.id === id)
    if (!record || record.consumedAt !== undefined) return false
    record.consumedAt = new Date().toISOString()
    return true
  }
}

/**
 * The configured approval queue, end to end (RFC 0016 §5.4 item 4). Only this
 * shows that `mcpPlugin({ approvals })` wires the pipeline *correctly* — store,
 * TTL, the route's redaction rules and the notify wrapper all reaching the gate
 * from one configuration object. `approval.test.ts` wires that pipeline by hand
 * for the gate's verdicts; nothing else boots the plugin with a queue at all.
 */
describe('mcpPlugin with an approval queue (integration)', () => {
  const tokens = new MemoryApiTokenStore()
  let app: Application
  let approvals: MemoryApprovalStore
  let notified: AgentApprovalRequest[]
  // "Nothing ran" is the claim the whole feature rests on, and a refusal that
  // reached the caller is not evidence for it — the route could have run and
  // its answer been discarded. So the handler records its own execution here.
  let executed: Array<Record<string, unknown>>
  let token: string

  beforeAll(async () => {
    approvals = new MemoryApprovalStore()
    notified = []
    executed = []

    app = createApp({
      routes: (router: Router) => {
        router
          .post(
            '/wires',
            { body: z.object({ amount: z.number(), memo: z.string() }) },
            ({ body }) => {
              executed.push(body)
              return Response.json({ ok: true })
            },
          )
          .name('wires.store')
          // `memo` on purpose: the default fragment list masks anything
          // password-shaped whichever redact list is in play, so a case written
          // with such a field would pass even if the route's own list were
          // dropped on the way to the gate. Only a field the defaults do not
          // know can tell the two apart.
          .agent({ approval: 'required', redact: ['memo'] })
      },
      providers: [
        EventServiceProvider,
        mcpPlugin({
          approvals: {
            store: approvals,
            notify: (request) => {
              notified.push(request)
            },
          },
        }),
      ],
    })
    app.auth.useTokens(tokens)
    await app.boot()

    const issued = await createApiToken(tokens, {
      name: 'approver-test',
      userId: 7,
      abilities: ['tool:wires.store'],
    })
    token = issued.plainTextToken
  })

  async function connectClient(): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
      fetch: (input, init) => app.fetch(new Request(input, init)),
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    })
    const client = new Client({ name: 'approvals', version: '1.0.0' })
    await client.connect(transport)
    return client
  }

  /** The JSON body an approval refusal carries beside its message. */
  function refusalBody(result: unknown): Record<string, unknown> {
    const blocks = (result as { content: Array<{ type: string; text: string }> }).content
    expect(blocks.length).toBe(2)
    return JSON.parse(blocks[1]!.text) as Record<string, unknown>
  }

  const CALL = { name: 'wires.store', arguments: { amount: 250, memo: 'rent' } }

  test('should list the gated tool and its status companion', async () => {
    // With a queue the tool *is* callable — the call becomes a pending
    // request, which is the interaction the queue exists to offer — so it
    // belongs in the catalogue, and `guren.approval_status` beside it.
    const names = (await (await connectClient()).listTools()).tools.map((tool) => tool.name)
    expect(names).toContain('wires.store')
    expect(names).toContain('guren.approval_status')
  })

  test('should turn the first call into a pending request and execute nothing', async () => {
    const client = await connectClient()
    const result = await client.callTool(CALL)

    // (a) The caller is told it is pending, with the id to poll on.
    expect(result.isError).toBe(true)
    const body = refusalBody(result)
    expect(body.status).toBe('pending')
    expect(body.executed).toBe(false)
    expect(body.tool).toBe('wires.store')
    expect(typeof body.requestId).toBe('string')

    // (b) One record, holding the arguments masked by the *route's* own rules.
    expect(approvals.records.length).toBe(1)
    const record = approvals.records[0]!
    expect(record.id).toBe(body.requestId as string)
    expect(record.tool).toBe('wires.store')
    expect(record.status).toBe('pending')
    expect(record.input).toEqual({ amount: 250, memo: '[REDACTED]' })

    // (c) The approvers were told once, about that exact record.
    expect(notified).toEqual([record])

    // (d) The handler never ran — the claim the feature rests on.
    expect(executed).toEqual([])
  })

  test('should execute the identical call once the request is approved, and spend it', async () => {
    const record = approvals.records[0]!
    expect(record).toBeDefined()
    record.status = 'approved'
    record.resolvedAt = new Date().toISOString()

    const client = await connectClient()
    const result = await client.callTool(CALL)

    // (e) It runs, with the *raw* arguments — the store's redacted copy is for
    // the human who approved it, never the retry material.
    expect(result.isError).toBeUndefined()
    expect(executed).toEqual([{ amount: 250, memo: 'rent' }])

    // Consumed before dispatch: an approval is permission for one attempt.
    expect(record.consumedAt).toBeDefined()
    // And no second record was filed for a call that was allowed through.
    expect(approvals.records.length).toBe(1)

    // Repeating it now finds no usable approval and files a fresh request
    // rather than running again on a spent one.
    const again = await client.callTool(CALL)
    expect(again.isError).toBe(true)
    expect(executed.length).toBe(1)
  })
})
