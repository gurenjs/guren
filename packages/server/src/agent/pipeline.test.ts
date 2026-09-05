/**
 * The invocation pipeline's own rules (RFC 0017 §1) — the ones a protocol
 * adapter must not be able to change and must not have to restate.
 * Driven against a stubbed application because what is under test is the *order*
 * of the steps and what each records; each step's behaviour is tested where it
 * lives (the gates in `gate.test.ts`, the request build in `dispatch`'s tests,
 * redaction in `redact.test.ts`), and the whole runs end to end through a real
 * app in `@guren/plugin-mcp`. Clocks are seeded at an absolute instant with
 * expiry after it: at the epoch every record expires and the cases lie green.
 */
import { describe, test, expect } from 'bun:test'

import type { AgentApprovalMatch, AgentApprovalRequest, AgentApprovalStore } from './approval'
import { deriveAgentTools, type DerivedAgentTool } from './derive'
import type { AgentToolDenied, AgentToolInvoked, AgentPrincipal } from './events'
import {
  createAgentInvocationPipeline,
  type AgentInvocationOptions,
  type AgentInvocationResult,
} from './pipeline'
import { Router } from '../mvc/Router'
import { readAgentPrincipal } from '../internal/agent-principal'

const NOW = new Date('2026-09-01T12:00:00.000Z')
const USER: AgentPrincipal = { kind: 'user', id: 7 }

function fixtureTools(): Record<'index' | 'show' | 'store' | 'destroy', DerivedAgentTool> {
  const router = new Router()
  const handler = () => new Response('ok')
  router.get('/posts', handler).name('posts.index').agent({})
  router.get('/posts/:id', handler).name('posts.show').agent({})
  router.post('/posts', handler).name('posts.store').agent({ redact: ['secret'] })
  router
    .delete('/posts/:id', handler)
    .name('posts.destroy')
    .agent({ approval: 'required', redact: ['secret'] })
  const byName = new Map(deriveAgentTools(router.definitions()).tools.map((t) => [t.toolName, t]))
  return {
    index: byName.get('posts.index')!,
    show: byName.get('posts.show')!,
    store: byName.get('posts.store')!,
    destroy: byName.get('posts.destroy')!,
  }
}

/** An array store whose `consume` is a compare-and-set, and nothing else. */
class MemoryApprovalStore implements AgentApprovalStore {
  readonly records: AgentApprovalRequest[] = []
  /** Set to make every method throw, standing in for a database that is down. */
  broken = false

  async create(request: AgentApprovalRequest): Promise<void> {
    this.guard()
    this.records.push(request)
  }

  async find(id: string): Promise<AgentApprovalRequest | null> {
    this.guard()
    return this.records.find((record) => record.id === id) ?? null
  }

  async findMatch(match: AgentApprovalMatch): Promise<AgentApprovalRequest | null> {
    this.guard()
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
    this.guard()
    const record = this.records.find((candidate) => candidate.id === id)
    if (!record || record.consumedAt !== undefined) return false
    record.consumedAt = NOW.toISOString()
    return true
  }

  private guard(): void {
    if (this.broken) throw new Error('the approval store is down')
  }
}

interface Harness {
  invoke(call: Parameters<ReturnType<typeof createAgentInvocationPipeline>['invoke']>[0]): Promise<AgentInvocationResult>
  /** Requests the stub application actually received, in order. */
  fetched: Request[]
  invoked: Array<{ tool: string; status: number; args: Record<string, unknown> }>
  denied: Array<{ tool: string; reason: string; args: Record<string, unknown> }>
  /** The order the steps ran in, appended by the hook and the store. */
  order: string[]
  store: MemoryApprovalStore
  notified: AgentApprovalRequest[]
}

function harness(
  overrides: Partial<AgentInvocationOptions> & { respond?: (request: Request) => Response } = {},
): Harness {
  const { respond, ...options } = overrides
  const fetched: Request[] = []
  const invoked: Harness['invoked'] = []
  const denied: Harness['denied'] = []
  const order: string[] = []
  const store = (options.approvals?.store as MemoryApprovalStore | undefined) ?? new MemoryApprovalStore()
  const notified: AgentApprovalRequest[] = []

  const pipeline = createAgentInvocationPipeline({
    app: {
      fetch: async (request) => {
        order.push('dispatch')
        fetched.push(request)
        return respond ? respond(request) : Response.json({ ok: true })
      },
    },
    principal: USER,
    abilities: ['tools:*'],
    surface: 'mcp',
    audit: (event: AgentToolInvoked | AgentToolDenied) => {
      if ('reason' in event) {
        denied.push({ tool: event.tool, reason: event.reason, args: event.arguments })
        return
      }
      invoked.push({ tool: event.tool, status: event.status, args: event.arguments })
    },
    ...options,
    ...(options.approvals
      ? {
          approvals: {
            ...options.approvals,
            notify: (request: AgentApprovalRequest) => {
              order.push('notify')
              notified.push(request)
              options.approvals?.notify(request)
            },
          },
        }
      : {}),
  })

  return { invoke: (call) => pipeline.invoke(call), fetched, invoked, denied, order, store, notified }
}

/** The approval configuration a queue-backed pipeline is built with. */
function approvalOptions(store: MemoryApprovalStore, order?: string[]): AgentInvocationOptions['approvals'] {
  return {
    store,
    principal: USER,
    now: () => NOW,
    redact: (tool, args) => {
      order?.push('redact')
      return args
    },
    notify: () => {},
  }
}

describe('the invocation pipeline: scope', () => {
  test('should deny an ungranted call, dispatch nothing, and audit the denial', async () => {
    const h = harness({ abilities: ['tools:read'] })
    const result = await h.invoke({ tool: fixtureTools().store, args: { title: 'x' } })

    expect(result.status).toBe('denied')
    if (result.status === 'denied') expect(result.denial.reason).toBe('scope')
    expect(h.fetched).toEqual([])
    expect(h.denied).toEqual([{ tool: 'posts.store', reason: 'scope', args: { title: 'x' } }])
    expect(h.invoked).toEqual([])
  })

  test('should redact the audited arguments of a denial by the route\'s own rules', async () => {
    const h = harness({ abilities: ['tools:read'] })
    await h.invoke({ tool: fixtureTools().store, args: { title: 'x', secret: 'hunter2' } })
    expect(h.denied[0]!.args.secret).not.toBe('hunter2')
  })

  /**
   * The refusal must not claim the caller holds a token: a durable agent's
   * principal is minted from its registration, so "widen the token's scopes"
   * names a thing its operator cannot find. Exact equality on both spellings —
   * the bearer one is promised unchanged, the default is what every other
   * surface reads.
   */
  test('should describe the caller neutrally by default', async () => {
    const h = harness({ abilities: ['tools:read'], surface: 'durable' })
    const result = await h.invoke({ tool: fixtureTools().store, args: {} })

    expect(result.status).toBe('denied')
    if (result.status === 'denied') {
      expect(result.denial.message).toBe('The caller\'s scopes do not grant the tool "posts.store".')
    }
  })

  test('should let a bearer surface name the token instead', async () => {
    const h = harness({ abilities: ['tools:read'], scopeSubject: "The token's scopes" })
    const result = await h.invoke({ tool: fixtureTools().store, args: {} })

    expect(result.status).toBe('denied')
    if (result.status === 'denied') {
      expect(result.denial.message).toBe('The token\'s scopes do not grant the tool "posts.store".')
    }
  })

  // A rehearsal takes the same scope rule through a different call, so a
  // subject wired into only one of them would have the two disagree about the
  // same refusal.
  test('should carry the subject into a rehearsal too', async () => {
    const h = harness({ abilities: ['tools:read'], scopeSubject: "The token's scopes" })
    const result = await h.invoke({ tool: fixtureTools().store, args: {}, preflight: true })

    expect(result.status).toBe('denied')
    if (result.status === 'denied') {
      expect(result.denial.message).toBe('The token\'s scopes do not grant the tool "posts.store".')
    }
  })
})

describe('the invocation pipeline: the interposition hook', () => {
  test('should run after the scope gate — an ungranted call is never metered', async () => {
    const order: string[] = []
    const h = harness({
      abilities: ['tools:read'],
      interpose: () => {
        order.push('hook')
        return undefined
      },
    })
    await h.invoke({ tool: fixtureTools().store, args: {} })
    expect(order).toEqual([])
  })

  /**
   * The ordering that matters most, and the one a `reason` assertion alone
   * cannot see: the approval gate writes a record and pages a human, so a hook
   * that ran *after* it would leave the budget guarding the execution while
   * the amplification happened in front of it. The evidence is the side
   * effects — an empty store and nobody notified.
   */
  test('should run before the approval gate, so a refused call files nothing', async () => {
    const store = new MemoryApprovalStore()
    const h = harness({
      approvals: approvalOptions(store),
      interpose: () => ({ reason: 'rate-limit', message: 'Rate limit exceeded. Retry later.' }),
    })

    const result = await h.invoke({ tool: fixtureTools().destroy, args: { id: 5 } })

    expect(result.status).toBe('denied')
    if (result.status === 'denied') {
      expect(result.denial.reason).toBe('rate-limit')
      expect(result.denial.message).toBe('Rate limit exceeded. Retry later.')
    }
    expect(store.records).toEqual([])
    expect(h.notified).toEqual([])
    expect(h.fetched).toEqual([])
    expect(h.denied).toEqual([{ tool: 'posts.destroy', reason: 'rate-limit', args: { id: 5 } }])
  })

  test('should dispatch when the hook allows', async () => {
    const h = harness({ interpose: () => undefined })
    const result = await h.invoke({ tool: fixtureTools().index, args: {} })
    expect(result.status).toBe('executed')
    expect(h.fetched.length).toBe(1)
  })
})

describe('the invocation pipeline: the approval gate', () => {
  test('should fail closed with no queue configured, dispatching nothing', async () => {
    const h = harness()
    const result = await h.invoke({ tool: fixtureTools().destroy, args: { id: 5 } })

    expect(result.status).toBe('denied')
    if (result.status === 'denied') {
      expect(result.denial.reason).toBe('approval')
      expect(result.denial.message).toContain('Nothing was executed')
    }
    expect(h.fetched).toEqual([])
    expect(h.denied).toEqual([{ tool: 'posts.destroy', reason: 'approval', args: { id: 5 } }])
  })

  test('should file a pending record and refuse the first call when a queue exists', async () => {
    const store = new MemoryApprovalStore()
    const h = harness({ approvals: approvalOptions(store) })

    const result = await h.invoke({ tool: fixtureTools().destroy, args: { id: 5 } })

    expect(result.status).toBe('denied')
    if (result.status === 'denied') {
      expect(result.denial.reason).toBe('approval')
      // The machine-readable half a caller polls with.
      expect(result.denial.body?.requestId).toBe(store.records[0]!.id)
      expect(result.denial.body?.executed).toBe(false)
    }
    expect(store.records.length).toBe(1)
    expect(h.notified.length).toBe(1)
    expect(h.fetched).toEqual([])
  })

  test('should store the record\'s input through the redaction rule it is given', async () => {
    const store = new MemoryApprovalStore()
    const h = harness({
      approvals: {
        ...approvalOptions(store)!,
        // The rule the plugin passes: the route's own `redact` list.
        redact: (tool, args) => ({ ...args, ...(tool.redact?.includes('secret') ? { secret: '[X]' } : {}) }),
      },
    })

    await h.invoke({ tool: fixtureTools().destroy, args: { id: 5, secret: 'hunter2' } })
    expect(store.records[0]!.input).toEqual({ id: 5, secret: '[X]' })
  })

  /**
   * A store that throws must not fall open: an approval gate that executed on
   * a storage error would run exactly the class of tool the whole feature
   * exists to hold back, on the day the database was already having a bad day.
   */
  test('should fail closed when the store throws, naming what broke', async () => {
    const store = new MemoryApprovalStore()
    store.broken = true
    const h = harness({ approvals: approvalOptions(store) })

    const result = await h.invoke({ tool: fixtureTools().destroy, args: { id: 5 } })

    expect(result.status).toBe('denied')
    if (result.status === 'denied') {
      expect(result.denial.reason).toBe('approval')
      expect(result.denial.message).toContain(
        'The approval queue could not be reached, so "posts.destroy" was not run and no request was recorded',
      )
    }
    expect(h.fetched).toEqual([])
    expect(h.denied).toEqual([{ tool: 'posts.destroy', reason: 'approval', args: { id: 5 } }])
  })

  test('should skip the approval gate for a rehearsal', async () => {
    // Rehearsing an approval-gated tool is the case the companion exists for,
    // and it executes nothing — so it must neither be refused fail-closed nor
    // file a record.
    const store = new MemoryApprovalStore()
    const h = harness({ approvals: approvalOptions(store) })

    const result = await h.invoke({ tool: fixtureTools().destroy, args: { id: 5 }, preflight: true })

    expect(result.status).toBe('executed')
    expect(store.records).toEqual([])
    expect(h.notified).toEqual([])
    expect(h.fetched.length).toBe(1)
  })
})

describe('the invocation pipeline: dispatch', () => {
  test('should build the request from the tool contract and forward the surface', async () => {
    const h = harness({ origin: 'https://app.example', authorization: 'Bearer t' })
    await h.invoke({ tool: fixtureTools().show, args: { id: 5 } })

    const request = h.fetched[0]!
    expect(request.url).toBe('https://app.example/posts/5')
    expect(request.method).toBe('GET')
    expect(request.headers.get('Authorization')).toBe('Bearer t')
    expect(request.headers.get('X-Guren-Agent-Surface')).toBe('mcp')
  })

  test('should announce a durable call as its own surface', async () => {
    const h = harness({ surface: 'durable' })
    await h.invoke({ tool: fixtureTools().index, args: {} })
    expect(h.fetched[0]!.headers.get('X-Guren-Agent-Surface')).toBe('durable')
    expect(h.invoked[0]).toEqual({ tool: 'posts.index', status: 200, args: {} })
  })

  test('should ask the route for a verdict when rehearsing', async () => {
    const h = harness()
    await h.invoke({ tool: fixtureTools().index, args: {}, preflight: true })
    expect(h.fetched[0]!.headers.get('X-Guren-Agent-Preflight')).toBe('1')
  })

  test('should report a build failure as a 400 invocation, with no HTTP', async () => {
    const h = harness()
    // `posts.destroy` needs `id` for its path; without it no URL can be built.
    const result = await h.invoke({ tool: fixtureTools().destroy, args: {}, preflight: true })

    expect(result.status).toBe('executed')
    if (result.status === 'executed') {
      expect(result.outcome.status).toBe(400)
      expect(result.outcome.isError).toBe(true)
      expect(result.outcome.content[0]!.text).toContain('Missing required path parameter')
    }
    expect(h.fetched).toEqual([])
    expect(h.invoked).toEqual([{ tool: 'posts.destroy', status: 400, args: {} }])
  })

  test('should record a dispatch throw as a 500 invocation and answer with its message', async () => {
    const h = harness({
      respond: () => {
        throw new Error('boom')
      },
    })
    const result = await h.invoke({ tool: fixtureTools().index, args: {} })

    expect(result.status).toBe('failed')
    if (result.status === 'failed') expect(result.message).toBe('boom')
    expect(h.invoked).toEqual([{ tool: 'posts.index', status: 500, args: {} }])
  })

  test('should map the application\'s own error response as an executed outcome', async () => {
    const h = harness({ respond: () => Response.json({ message: 'nope' }, { status: 403 }) })
    const result = await h.invoke({ tool: fixtureTools().index, args: {} })

    expect(result.status).toBe('executed')
    if (result.status === 'executed') expect(result.outcome.status).toBe(403)
    expect(h.invoked).toEqual([{ tool: 'posts.index', status: 403, args: {} }])
  })
})

describe('the invocation pipeline: audit', () => {
  test('should redact the invocation arguments by the route\'s own rules', async () => {
    const h = harness()
    await h.invoke({ tool: fixtureTools().store, args: { title: 'x', secret: 'hunter2' } })
    expect(h.invoked[0]!.args.title).toBe('x')
    expect(h.invoked[0]!.args.secret).not.toBe('hunter2')
  })

  /**
   * The one call whose audited identity is not its dispatched one. Recording
   * the *checked* tool would make a refused rehearsal indistinguishable from a
   * refused write; recording the meta-tool's arguments under the meta-tool's
   * (empty) redaction list would publish exactly the fields the checked route
   * said must never be written down.
   */
  test('should audit a rehearsal under the meta-tool, with the checked tool\'s redaction', async () => {
    const h = harness()
    const outer = { tool: 'posts.store', input: { title: 'x', secret: 'hunter2' } }

    await h.invoke({
      tool: fixtureTools().store,
      args: outer.input,
      preflight: true,
      audited: { toolName: 'guren.preflight', redact: fixtureTools().store.redact },
      auditedArguments: outer,
    })

    expect(h.invoked.length).toBe(1)
    expect(h.invoked[0]!.tool).toBe('guren.preflight')
    const recorded = h.invoked[0]!.args.input as Record<string, unknown>
    expect(recorded.title).toBe('x')
    expect(recorded.secret).not.toBe('hunter2')
    // The *checked* tool's own arguments still went to the route, unredacted.
    expect(await h.fetched[0]!.json()).toEqual({ title: 'x', secret: 'hunter2' })
  })

  test('should work with no emitter at all, recording nothing', async () => {
    const fetched: Request[] = []
    const pipeline = createAgentInvocationPipeline({
      app: {
        fetch: async (request) => {
          fetched.push(request)
          return Response.json({ ok: true })
        },
      },
      principal: USER,
      abilities: ['tools:*'],
      surface: 'cli',
    })

    const result = await pipeline.invoke({ tool: fixtureTools().index, args: {} })
    expect(result.status).toBe('executed')
    expect(fetched.length).toBe(1)
  })
})

describe('the invocation pipeline: the principal handoff', () => {
  test('should install the principal on the dispatched request under handoff: seam', async () => {
    const h = harness({ handoff: 'seam' })
    await h.invoke({ tool: fixtureTools().index, args: {} })

    expect(readAgentPrincipal(h.fetched[0]!)).toEqual({
      principal: USER,
      abilities: ['tools:*'],
    })
  })

  test('should install nothing without the option', async () => {
    const h = harness()
    await h.invoke({ tool: fixtureTools().index, args: {} })
    expect(readAgentPrincipal(h.fetched[0]!)).toBeUndefined()
  })

  test('should install nothing for a call with no principal', async () => {
    const h = harness({ handoff: 'seam', principal: null })
    await h.invoke({ tool: fixtureTools().index, args: {} })
    expect(readAgentPrincipal(h.fetched[0]!)).toBeUndefined()
  })

  /**
   * Two answers to "who is this" on one request is a wiring bug, and the
   * honest moment to say so is construction — before a single call has been
   * dispatched under an identity nobody decided. Silently preferring one would
   * make the answer depend on guard-resolution order.
   */
  test('should refuse to be built with both an Authorization and the seam', () => {
    expect(() => harness({ handoff: 'seam', authorization: 'Bearer t' })).toThrow(
      /mutually exclusive/,
    )
  })

  test('should allow either one on its own', () => {
    expect(() => harness({ handoff: 'seam' })).not.toThrow()
    expect(() => harness({ authorization: 'Bearer t' })).not.toThrow()
  })
})
