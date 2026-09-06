/**
 * The approval queue on the App MCP endpoint (RFC 0016 §5.4 item 4). Driven
 * through the real MCP client wherever the answer the *caller* sees is under
 * test: the pending answer rides as an `isError` result carrying JSON — the one
 * measured protocol fact this feature rests on — and asserting against the
 * server object directly would never exercise the SDK's delivery of it. Clocks
 * are seeded at an absolute instant with expiry after it; seeding in the past
 * would expire every record and pass the expiry cases for the wrong reason.
 */
import { describe, test, expect } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  Router,
  agentApprovalFingerprint,
  agentApprovalPrincipalKey,
  createAgentInvocationPipeline,
  deriveAgentTools,
  notifyApprovers,
  redactAgentArguments,
  type AgentApprovalMatch,
  type AgentApprovalRequest,
  type AgentApprovalStore,
  type AgentPrincipal,
  type AgentToolDenialReason,
  type DerivedAgentTool,
} from '@guren/core'

import { AgentRateLimiter, createRateLimitInterposition } from './rate-limit'
import { createAppMcpServer, type AppMcpServerOptions } from './server'

const NOW = new Date('2026-09-01T12:00:00.000Z')
const USER: AgentPrincipal = { kind: 'user', id: 7 }
const OTHER: AgentPrincipal = { kind: 'user', id: 8 }

/**
 * A store with no cleverness in it: an array, and a `consume` that is a
 * compare-and-set because the interface requires one. Nothing here filters
 * expiry or status — that is the framework's job, and a fixture that filtered
 * would hide a gate that had stopped checking.
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

/** Seed an approved record for a call, as a human resolving it would. */
async function seedApproved(
  store: MemoryApprovalStore,
  input: Record<string, unknown>,
  overrides: Partial<AgentApprovalRequest> = {},
): Promise<AgentApprovalRequest> {
  const record: AgentApprovalRequest = {
    id: `req-${store.records.length + 1}`,
    tool: 'posts.destroy',
    input,
    fingerprint: await agentApprovalFingerprint(input),
    principal: USER,
    principalKey: agentApprovalPrincipalKey(USER),
    requestedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    status: 'approved',
    resolvedAt: NOW.toISOString(),
    resolvedBy: 'ops@example.com',
    ...overrides,
  }
  store.records.push(record)
  return record
}

function fixtureTools(): DerivedAgentTool[] {
  const router = new Router()
  const handler = () => new Response('ok')
  router.get('/posts', handler).name('posts.index').agent({})
  router
    .delete('/posts/:id', handler)
    .name('posts.destroy')
    .agent({ approval: 'required', redact: ['secret'] })
  return deriveAgentTools(router.definitions()).tools
}

interface Harness {
  client: Client
  store: MemoryApprovalStore
  notified: AgentApprovalRequest[]
  dispatched: Array<{ tool: string; args: Record<string, unknown> }>
  denied: Array<{ tool: string; reason: AgentToolDenialReason }>
  invoked: Array<{ tool: string; status: number }>
}

async function connect(
  options: {
    store?: MemoryApprovalStore | null
    principal?: AgentPrincipal
    now?: () => Date
    notify?: (request: AgentApprovalRequest) => void | Promise<void>
    overrides?: Partial<AppMcpServerOptions>
  } = {},
): Promise<Harness> {
  const store = options.store === null ? null : (options.store ?? new MemoryApprovalStore())
  const notified: AgentApprovalRequest[] = []
  const dispatched: Harness['dispatched'] = []
  const denied: Harness['denied'] = []
  const invoked: Harness['invoked'] = []
  const rateKey = options.overrides?.rateKey ?? 'token-1'

  // The one configuration, read by both halves — the gate that files records
  // and the status tool that reports on them — so the two cannot disagree
  // about whether a queue exists.
  const approvals = store
    ? { store, principal: options.principal ?? USER, now: options.now ?? (() => NOW) }
    : undefined

  // Which call the pipeline is running, so the stubbed application can answer
  // for it. The *recording* happens inside `fetch`, so `dispatched` is
  // evidence the request really reached the application — which is what the
  // `toEqual([])` cases below are asserting.
  let inflight: { tool: DerivedAgentTool; args: Record<string, unknown>; preflight: boolean } | undefined

  // The real pipeline over a stubbed application: the approval gate, its
  // ordering behind the rate-limit interposition, the redaction and the audit
  // records asserted below are the framework's own.
  const inner = createAgentInvocationPipeline({
    app: {
      fetch: async (): Promise<Response> => {
        const call = inflight!
        dispatched.push({ tool: call.tool.toolName, args: call.args })
        return call.preflight ? seamVerdict() : Response.json({ ok: true })
      },
    },
    principal: options.principal ?? USER,
    abilities: options.overrides?.abilities ?? ['tools:*'],
    surface: 'mcp',
    audit: (event) => {
      if ('reason' in event) {
        denied.push({ tool: event.tool, reason: event.reason })
        return
      }
      invoked.push({ tool: event.tool, status: event.status })
    },
    ...(approvals
      ? {
          approvals: {
            ...approvals,
            redact: (tool, args) => redactAgentArguments(args, tool.redact),
            // Through the framework's own wrapper, not around it: the guarantee
            // that a failed notification neither fails the call nor loses the
            // record lives in `notifyApprovers`.
            notify: notifyApprovers(
              options.notify
              ?? ((request) => {
                notified.push(request)
              }),
            ),
          },
        }
      : {}),
    approvalConfigureHint: 'mcpPlugin({ approvals: { store, notify } })',
    interpose: createRateLimitInterposition(options.overrides?.limiter, rateKey),
  })

  const server = createAppMcpServer({
    tools: fixtureTools(),
    abilities: ['tools:*'],
    serverInfo: { name: 'test-app', version: '0.0.0' },
    rateKey,
    ...(approvals ? { approvals } : {}),
    pipeline: {
      invoke: (call) => {
        inflight = { tool: call.tool, args: call.args, preflight: call.preflight === true }
        return inner.invoke(call)
      },
    },
    onInvoked: (tool, _args, status) => invoked.push({ tool: tool.toolName, status }),
    onDenied: (tool, _args, reason) => denied.push({ tool: tool.toolName, reason }),
    ...options.overrides,
  })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return { client, store: store ?? new MemoryApprovalStore(), notified, dispatched, denied, invoked }
}

/**
 * The preflight seam's own verdict header, spelled out because the constant is
 * internal to `@guren/server`: a rename leaves this string classifying nothing,
 * turning the rehearsal case red rather than letting it quietly keep passing.
 */
const VERDICT_HEADER = 'X-Guren-Agent-Preflight-Verdict'

/** What the router's preflight seam answers for an allowed rehearsal. */
function seamVerdict(): Response {
  return new Response(
    JSON.stringify({ preflight: true, allowed: true, validated: [], unverified: [] }),
    { status: 200, headers: { 'Content-Type': 'application/json', [VERDICT_HEADER]: '1' } },
  )
}

/**
 * The JSON body an approval refusal carries beside its message. Takes `unknown`
 * rather than a `{ content }` shape: the SDK's own `CallToolResult` carries an
 * index signature, and narrowing it here would restate, more weakly, what a
 * result is.
 */
function refusalBody(result: unknown): Record<string, unknown> {
  const blocks = (result as { content: Array<{ type: string; text: string }> }).content
  expect(blocks.length).toBe(2)
  return JSON.parse(blocks[1]!.text) as Record<string, unknown>
}

describe('the approval gate with no queue configured', () => {
  test('should refuse fail-closed, naming the configuration line', async () => {
    const { client, denied, dispatched } = await connect({ store: null })
    const result = await client.callTool({ name: 'posts.destroy', arguments: { id: 5 } })

    expect(result.isError).toBe(true)
    // Exact, not a substring: the release notes promise this endpoint's refusal
    // text byte for byte, and only equality holds anyone to that. The
    // configuration line is the half that drifts first — the pipeline's own
    // default names no plugin at all, so a surface that stopped passing its
    // hint would still satisfy every `toContain` above but one.
    const text = (result.content as Array<{ text: string }>)[0]!.text
    expect(text).toBe(
      'The tool "posts.destroy" requires server-side approval, and this server has no approval '
      + 'queue configured. Nothing was executed. Configure one with '
      + 'mcpPlugin({ approvals: { store, notify } }).',
    )
    expect(denied).toEqual([{ tool: 'posts.destroy', reason: 'approval' }])
    expect(dispatched).toEqual([])
  })

  test('should leave the tool out of the catalogue, with no status companion', async () => {
    const { client } = await connect({ store: null })
    const names = (await client.listTools()).tools.map((tool) => tool.name)
    expect(names).not.toContain('posts.destroy')
    expect(names).not.toContain('guren.approval_status')
  })
})

describe('the approval gate with a queue', () => {
  test('should list the gated tool and the status companion', async () => {
    const { client } = await connect()
    const names = (await client.listTools()).tools.map((tool) => tool.name)
    expect(names).toContain('posts.destroy')
    expect(names).toContain('guren.approval_status')
  })

  test('should create no record and notify nobody for tools/list', async () => {
    const { client, store, notified } = await connect()
    await client.listTools()
    await client.listTools()
    expect(store.records).toEqual([])
    expect(notified).toEqual([])
  })

  test('should refuse a first call with a pending record, executing nothing', async () => {
    const { client, store, notified, dispatched, denied } = await connect()
    const result = await client.callTool({ name: 'posts.destroy', arguments: { id: 5 } })

    expect(result.isError).toBe(true)
    expect(dispatched).toEqual([])
    expect(denied).toEqual([{ tool: 'posts.destroy', reason: 'approval' }])

    expect(store.records.length).toBe(1)
    const record = store.records[0]!
    expect(record.status).toBe('pending')
    expect(notified).toEqual([record])

    const body = refusalBody(result)
    expect(body.status).toBe('pending')
    expect(body.requestId).toBe(record.id)
    expect(body.tool).toBe('posts.destroy')
    expect(body.executed).toBe(false)
    expect(body.pollWith).toBe('guren.approval_status')
    expect((result.content as Array<{ text: string }>)[0]!.text).toContain('Nothing was executed')
  })

  test('should store the arguments redacted by the route\'s own rules', async () => {
    const { client, store } = await connect()
    await client.callTool({ name: 'posts.destroy', arguments: { id: 5, secret: 'hunter2' } })
    expect(store.records[0]!.input).toEqual({ id: 5, secret: '[REDACTED]' })
  })

  test('should bind the record to the raw arguments, not the redacted copy', async () => {
    const { client, store } = await connect()
    await client.callTool({ name: 'posts.destroy', arguments: { id: 5, secret: 'a' } })
    await client.callTool({ name: 'posts.destroy', arguments: { id: 5, secret: 'b' } })
    // Two calls that redact identically are still two different calls; if the
    // fingerprint were taken from `input`, the second would have found the
    // first pending and created nothing.
    expect(store.records.length).toBe(2)
  })

  test('should reuse the pending record rather than notify again on a repeat', async () => {
    const { client, store, notified } = await connect()
    const first = refusalBody(await client.callTool({ name: 'posts.destroy', arguments: { id: 5 } }))
    const second = refusalBody(await client.callTool({ name: 'posts.destroy', arguments: { id: 5 } }))

    expect(second.requestId).toBe(first.requestId)
    expect(store.records.length).toBe(1)
    expect(notified.length).toBe(1)
  })

  test('should report a rejected call distinctly and not re-ask', async () => {
    const store = new MemoryApprovalStore()
    await seedApproved(store, { id: 5 }, { status: 'rejected' })
    const { client, notified } = await connect({ store })

    const body = refusalBody(await client.callTool({ name: 'posts.destroy', arguments: { id: 5 } }))
    expect(body.status).toBe('rejected')
    expect(store.records.length).toBe(1)
    expect(notified).toEqual([])
  })

  test('should let an expired rejection be asked again as a new question', async () => {
    // A rejection blocks while its record is live, which is what stops a retry
    // from costing a human's "no" nothing. Blocking *forever* would denylist
    // that exact call for that principal permanently, with no remedy short of
    // deleting the row. `guren.approval_status` still reports it as rejected,
    // but the gate stops holding it against a new request once it expires.
    const store = new MemoryApprovalStore()
    await seedApproved(store, { id: 5 }, {
      status: 'rejected',
      expiresAt: new Date(NOW.getTime() - 1_000).toISOString(),
    })
    const { client, notified } = await connect({ store })

    const body = refusalBody(await client.callTool({ name: 'posts.destroy', arguments: { id: 5 } }))
    expect(body.status).toBe('pending')
    expect(store.records.length).toBe(2)
    expect(notified.length).toBe(1)
  })

  test('should let an approved call through exactly once', async () => {
    const store = new MemoryApprovalStore()
    await seedApproved(store, { id: 5 })
    const { client, dispatched, denied } = await connect({ store })

    const first = await client.callTool({ name: 'posts.destroy', arguments: { id: 5 } })
    expect(first.isError).toBeUndefined()
    expect(dispatched).toEqual([{ tool: 'posts.destroy', args: { id: 5 } }])

    const second = await client.callTool({ name: 'posts.destroy', arguments: { id: 5 } })
    expect(second.isError).toBe(true)
    expect(refusalBody(second).status).toBe('pending')
    // Still one dispatch: the approval was spent by the first call.
    expect(dispatched.length).toBe(1)
    expect(denied).toEqual([{ tool: 'posts.destroy', reason: 'approval' }])
  })

  // The principal-less refusal is unreachable from this surface, so it is driven
  // against the gate directly, in `packages/server/src/agent/gate.test.ts`.

  test('should meter the request before filing it or paging anyone', async () => {
    // The gate writes a record and sends mail, and deduplicates only on identical
    // arguments — so a caller varying one field pages a human per call. Metering
    // after that work would leave the amplification in front of the budget.
    const store = new MemoryApprovalStore()
    const limiter = new AgentRateLimiter({ max: 10, writeMax: 1, windowMs: 60_000 })
    const { client, denied, notified } = await connect({ store, overrides: { limiter } })

    await client.callTool({ name: 'posts.destroy', arguments: { id: 1 } })
    const second = await client.callTool({ name: 'posts.destroy', arguments: { id: 2 } })

    expect(second.isError).toBe(true)
    expect(denied.at(-1)).toEqual({ tool: 'posts.destroy', reason: 'rate-limit' })
    // The refused call filed nothing and paged nobody; the first still did.
    expect(store.records.length).toBe(1)
    expect(notified.length).toBe(1)
  })

  test('should refuse a lost consume race as spent, without filing a new request', async () => {
    // Both calls read the same unconsumed record and pass the usability check;
    // one wins `consume`. The loser's copy still says approved, so falling
    // through to the generic branch would open a fresh request — N concurrent
    // calls producing N-1 records and N-1 pages to a human. A store whose
    // `consume` always loses drives it: a scheduler race is not a test.
    class ContendedStore extends MemoryApprovalStore {
      override async consume(): Promise<boolean> {
        return false
      }
    }
    const store = new ContendedStore()
    await seedApproved(store, { id: 5 })
    const { client, dispatched, notified } = await connect({ store })

    const result = await client.callTool({ name: 'posts.destroy', arguments: { id: 5 } })

    expect(result.isError).toBe(true)
    expect(refusalBody(result).status).toBe('spent')
    expect(dispatched).toEqual([])
    // The two that matter: no new record, and nobody paged.
    expect(store.records.length).toBe(1)
    expect(notified).toEqual([])
  })

  test('should not let an approval for {id: 5} authorize {id: 9}', async () => {
    const store = new MemoryApprovalStore()
    await seedApproved(store, { id: 5 })
    const { client, dispatched } = await connect({ store })

    const result = await client.callTool({ name: 'posts.destroy', arguments: { id: 9 } })
    expect(result.isError).toBe(true)
    expect(refusalBody(result).status).toBe('pending')
    expect(dispatched).toEqual([])
  })

  test('should match regardless of key order or nesting order', async () => {
    const store = new MemoryApprovalStore()
    await seedApproved(store, { id: 5, where: { a: 1, b: 2 } })
    const { client, dispatched } = await connect({ store })

    const result = await client.callTool({
      name: 'posts.destroy',
      arguments: { where: { b: 2, a: 1 }, id: 5 },
    })
    expect(result.isError).toBeUndefined()
    expect(dispatched.length).toBe(1)
  })

  test('should let an approval for another principal authorize nothing', async () => {
    const store = new MemoryApprovalStore()
    await seedApproved(store, { id: 5 })
    const { client, dispatched } = await connect({ store, principal: OTHER })

    const result = await client.callTool({ name: 'posts.destroy', arguments: { id: 5 } })
    expect(result.isError).toBe(true)
    expect(dispatched).toEqual([])
  })

  test('should let an expired approval authorize nothing', async () => {
    const store = new MemoryApprovalStore()
    const approved = await seedApproved(store, { id: 5 })
    const later = new Date(Date.parse(approved.expiresAt) + 1)
    const { client, dispatched } = await connect({ store, now: () => later })

    const result = await client.callTool({ name: 'posts.destroy', arguments: { id: 5 } })
    expect(result.isError).toBe(true)
    expect(dispatched).toEqual([])
    // The expired one is left alone and a fresh request is filed instead.
    expect(store.records.length).toBe(2)
    expect(refusalBody(result).requestId).toBe(store.records[1]!.id)
  })

  test('should keep the call and the record when the notification throws', async () => {
    const { client, store } = await connect({
      notify: () => {
        throw new Error('smtp is down')
      },
    })

    const result = await client.callTool({ name: 'posts.destroy', arguments: { id: 5 } })
    expect(result.isError).toBe(true)
    expect(refusalBody(result).status).toBe('pending')
    expect(store.records.length).toBe(1)
  })

  test('should keep the call and the record when the notification rejects', async () => {
    const { client, store } = await connect({
      notify: () => Promise.reject(new Error('the mail queue is down')),
    })

    const result = await client.callTool({ name: 'posts.destroy', arguments: { id: 5 } })
    expect(refusalBody(result).status).toBe('pending')
    expect(store.records.length).toBe(1)
  })

  test('should fail closed when the store itself throws', async () => {
    const store = new MemoryApprovalStore()
    store.findMatch = async () => {
      throw new Error('database unreachable')
    }
    const { client, dispatched, denied } = await connect({ store })

    const result = await client.callTool({ name: 'posts.destroy', arguments: { id: 5 } })
    expect(result.isError).toBe(true)
    expect((result.content as Array<{ text: string }>)[0]!.text).toContain(
      'approval queue could not be reached',
    )
    expect(dispatched).toEqual([])
    expect(denied).toEqual([{ tool: 'posts.destroy', reason: 'approval' }])
  })

  test('should create no record when a gated tool is only rehearsed', async () => {
    const { client, store, notified, dispatched } = await connect()
    const result = await client.callTool({
      name: 'guren.preflight',
      arguments: { tool: 'posts.destroy', input: { id: 5 } },
    })

    // Rehearsing is not requesting: a preflight that filed a request would let an
    // agent page the approvers by asking questions.
    expect(result.isError).toBeUndefined()
    expect((result.structuredContent as { allowed: boolean }).allowed).toBe(true)
    expect(dispatched).toEqual([{ tool: 'posts.destroy', args: { id: 5 } }])
    expect(store.records).toEqual([])
    expect(notified).toEqual([])
  })
})

describe('guren.approval_status', () => {
  test('should report a pending request to the caller that created it', async () => {
    const { client, store } = await connect()
    await client.callTool({ name: 'posts.destroy', arguments: { id: 5 } })
    const record = store.records[0]!

    const result = await client.callTool({
      name: 'guren.approval_status',
      arguments: { requestId: record.id },
    })

    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toEqual({
      requestId: record.id,
      status: 'pending',
      tool: 'posts.destroy',
      requestedAt: record.requestedAt,
      expiresAt: record.expiresAt,
      executed: false,
    })
  })

  test('should report a spent approval as consumed, so a caller does not repeat it', async () => {
    const store = new MemoryApprovalStore()
    const spent = await seedApproved(store, { id: 5 }, { consumedAt: NOW.toISOString() })
    const { client } = await connect({ store })

    const result = await client.callTool({
      name: 'guren.approval_status',
      arguments: { requestId: spent.id },
    })

    // Still "approved" — the human said yes — but the one call it permitted has
    // run. A caller that repeated it would file a fresh request and, on
    // approval, perform the action a second time.
    expect(result.structuredContent).toMatchObject({
      status: 'approved',
      consumedAt: NOW.toISOString(),
    })
  })

  test('should omit consumedAt while an approval is still available', async () => {
    const store = new MemoryApprovalStore()
    const approved = await seedApproved(store, { id: 5 })
    const { client } = await connect({ store })

    const result = await client.callTool({
      name: 'guren.approval_status',
      arguments: { requestId: approved.id },
    })

    expect(result.structuredContent).not.toHaveProperty('consumedAt')
  })

  test('should report an approved request with its resolution', async () => {
    const store = new MemoryApprovalStore()
    const approved = await seedApproved(store, { id: 5 })
    const { client } = await connect({ store })

    const result = await client.callTool({
      name: 'guren.approval_status',
      arguments: { requestId: approved.id },
    })
    expect(result.structuredContent).toMatchObject({
      status: 'approved',
      resolvedBy: 'ops@example.com',
      executed: false,
    })
  })

  test('should report a pending request past its window as expired', async () => {
    const { client, store } = await connect()
    await client.callTool({ name: 'posts.destroy', arguments: { id: 5 } })
    const record = store.records[0]!

    const later = await connect({ store, now: () => new Date(Date.parse(record.expiresAt) + 1) })
    const result = await later.client.callTool({
      name: 'guren.approval_status',
      arguments: { requestId: record.id },
    })
    expect((result.structuredContent as { status: string }).status).toBe('expired')
  })

  test('should answer another principal\'s id exactly as it answers an unknown one', async () => {
    // Two servers over the same principal and the *same request id string*: one
    // store holds the record (owned by USER, asked after by OTHER), the other
    // has never heard of it. Only the id's existence differs, which is exactly
    // the bit that must not be observable.
    const owning = new MemoryApprovalStore()
    const owned = await seedApproved(owning, { id: 5 })
    const empty = new MemoryApprovalStore()

    const foreignHarness = await connect({ store: owning, principal: OTHER })
    const foreign = await foreignHarness.client.callTool({
      name: 'guren.approval_status',
      arguments: { requestId: owned.id },
    })
    const unknownHarness = await connect({ store: empty, principal: OTHER })
    const unknown = await unknownHarness.client.callTool({
      name: 'guren.approval_status',
      arguments: { requestId: owned.id },
    })

    // Deep equality of the whole result, not `isError` on each: two refusals
    // whose text differs are two distinguishable answers, and a pair of
    // `isError` assertions would pass straight through that difference.
    expect(foreign).toEqual(unknown)
    expect(foreign.isError).toBe(true)

    // And the other half of the same rule: the audit trail *does* keep the
    // distinction the caller is denied. Without it both cases reach the trail as
    // an identical 404, and a caller walking ids to find other principals'
    // pending actions looks like one mistyping its own.
    expect(foreignHarness.invoked.at(-1)?.status).toBe(403)
    expect(unknownHarness.invoked.at(-1)?.status).toBe(404)
  })

  test('should record a status check as an invocation under the meta-tool', async () => {
    const store = new MemoryApprovalStore()
    const approved = await seedApproved(store, { id: 5 })
    const { client, invoked } = await connect({ store })

    await client.callTool({ name: 'guren.approval_status', arguments: { requestId: approved.id } })
    await client.callTool({ name: 'guren.approval_status', arguments: { requestId: 'nope' } })

    expect(invoked).toEqual([
      { tool: 'guren.approval_status', status: 200 },
      { tool: 'guren.approval_status', status: 404 },
    ])
  })

  test('should be metered on the read budget, like preflight', async () => {
    const { client, denied } = await connect({
      overrides: { limiter: new AgentRateLimiter({ max: 1, writeMax: 1, windowMs: 60_000 }) },
    })

    await client.callTool({ name: 'guren.approval_status', arguments: { requestId: 'x' } })
    const throttled = await client.callTool({
      name: 'guren.approval_status',
      arguments: { requestId: 'x' },
    })

    expect(throttled.isError).toBe(true)
    expect(denied).toEqual([{ tool: 'guren.approval_status', reason: 'rate-limit' }])
  })

  test('should refuse arguments that name no request', async () => {
    const { client } = await connect()
    const result = await client.callTool({ name: 'guren.approval_status', arguments: {} })
    expect(result.isError).toBe(true)
    expect((result.content as Array<{ text: string }>)[0]!.text).toContain('"requestId" argument')
  })
})
