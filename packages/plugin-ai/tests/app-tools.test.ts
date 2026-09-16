// Set before anything imports @guren/core: the fixture mounts CSRF middleware,
// which needs a signing key.
process.env.APP_KEY = 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { AgentToolDenied, AgentToolInvoked, definePlugin } from '@guren/core'
// The real other publisher of `agent.audit`, so a change to when `mcpPlugin`
// binds it fails here rather than passing against a stand-in.
import { mcpPlugin } from '@guren/plugin-mcp'

import { Agent, type AgentToolScope, type AiManager } from '../src'
import { MemoryApprovalStore, bootHarness, drainEvents, type Harness } from './fixture'

class Reader extends Agent {
  static override agentName = 'reader'
  static override scopes: readonly AgentToolScope[] = ['tool:posts.index', 'tool:echo_me']
  instructions = 'Read posts.'

  override tools() {
    return this.appTools(['posts.index', 'echo_me'])
  }
}

class Writer extends Agent {
  static override agentName = 'writer'
  static override scopes: readonly AgentToolScope[] = ['tools:posts.*']
  instructions = 'Write posts.'

  override tools() {
    return this.appTools(['posts.store', 'posts.publish', 'posts.destroy'])
  }
}

class Late extends Agent {
  static override scopes: readonly AgentToolScope[] = ['tool:late_tool']
  instructions = 'x'
  override tools() {
    return this.appTools(['late_tool'])
  }
}

const store = new MemoryApprovalStore()
let h: Harness
let ai: AiManager

beforeAll(async () => {
  h = await bootHarness({ plugin: { approvals: { store, notify: () => {} } } })
  ai = h.app.container.make('ai')
})

afterEach(() => {
  h.records.length = 0
  store.records.length = 0
})

/** The one tool result a single-call script produced. */
function onlyOutput<T>(response: Parameters<typeof toolResults>[0]): T {
  const results = toolResults(response)
  expect(results).toHaveLength(1)
  return results[0]![1] as T
}

function toolResults(response: { steps: Array<{ toolResults: Array<{ toolName: string; output: unknown }> }> }) {
  return response.steps.flatMap((step) => step.toolResults.map((result) => [result.toolName, result.output]))
}

describe('appTools: the allowed path', () => {
  test('should dispatch a granted tool through the application and hand its body to the model', async () => {
    const model = h.script([
      { toolCalls: [{ name: 'posts.index', input: {} }] },
      { text: 'There is one post.' },
    ])

    const response = await ai.agent(Reader).as({ id: 7 }).prompt('How many posts?')

    expect(response.text).toBe('There is one post.')
    expect(toolResults(response)).toEqual([['posts.index', { posts: [{ id: 1 }] }]])
    expect(model.doGenerateCalls[0]!.tools?.map((advertised) => advertised.name)).toEqual(['posts.index', 'echo_me'])
  })

  test('should authenticate the route as the principal passed to as()', async () => {
    h.script([{ toolCalls: [{ name: 'echo_me', input: {} }] }, { text: 'done' }])

    const response = await ai.agent(Reader).as({ id: 42, kind: 'user' }).prompt('Who am I?')

    // Without the seam, requireAuthenticated() answers 401 and this is an error body.
    expect(toolResults(response)).toEqual([['echo_me', { user: { id: 42 } }]])
  })

  test('should record every call under the in-process surface with the principal and redacted arguments', async () => {
    h.script([{ toolCalls: [{ name: 'posts.store', input: { title: 'Hi', secret: 'hunter2' } }] }, { text: 'ok' }])

    await ai.agent(Writer).as({ id: 1 }).prompt('Write one.')
    await drainEvents()

    expect(h.records).toHaveLength(1)
    const record = h.records[0] as AgentToolInvoked
    expect(record).toBeInstanceOf(AgentToolInvoked)
    expect(record.surface).toBe('in-process')
    expect(record.status).toBe(200)
    expect(record.principal).toEqual({ kind: 'user', id: 1 })
    expect(record.arguments.secret).not.toBe('hunter2')
  })

  test('should hand the model an error body, not a throw, when the route refuses', async () => {
    h.script([{ toolCalls: [{ name: 'posts.destroy', input: { id: 1 } }] }, { text: 'ok' }])

    const response = await ai.agent(Writer).as({ id: 1 }).prompt('Delete it.')

    expect(toolResults(response)).toEqual([['posts.destroy', { error: true, status: 403, body: { error: 'forbidden' } }]])
  })
})

describe('appTools: the gates', () => {
  test('should deny, and audit the denial, when the principal abilities narrow the class scopes', async () => {
    h.script([{ toolCalls: [{ name: 'posts.store', input: { title: 'Hi' } }] }, { text: 'ok' }])

    // `tools:posts.*` on the class, only `posts.index` consented to by the caller.
    const response = await ai.agent(Writer).as({ id: 1, abilities: ['tool:posts.index'] }).prompt('Write one.')
    await drainEvents()

    expect(onlyOutput<{ denied: string }>(response).denied).toBe('scope')
    expect(h.records).toHaveLength(1)
    expect(h.records[0]).toBeInstanceOf(AgentToolDenied)
    expect((h.records[0] as AgentToolDenied).reason).toBe('scope')
    expect(h.records[0]!.surface).toBe('in-process')
  })

  test('should queue an approval-gated tool instead of running it, and tell the model the request id', async () => {
    h.script([{ toolCalls: [{ name: 'posts.publish', input: { id: 3 } }] }, { text: 'waiting' }])

    const response = await ai.agent(Writer).as({ id: 1 }).prompt('Publish 3.')

    const output = onlyOutput<{ denied: string; approval: { status: string; requestId: string } }>(response)
    expect(output.denied).toBe('approval')
    expect(output.approval.status).toBe('pending')
    expect(store.records.map((record) => record.id)).toEqual([output.approval.requestId])
  })

  test('should meter calls per bound instance', async () => {
    const calls = Array.from({ length: 61 }, () => ({ name: 'posts.index', input: {} }))
    h.script([{ toolCalls: calls }, { text: 'done' }])

    const response = await ai.agent(Reader).as({ id: 1 }).prompt('Spam.')

    const outputs = toolResults(response).map(([, output]) => output as { denied?: string })
    expect(outputs.filter((output) => output.denied === 'rate-limit')).toHaveLength(1)
  })
})

describe('appTools: construction errors', () => {
  test('should refuse a name no route derives and a name the scopes do not grant, naming both', () => {
    class Confused extends Agent {
      static override scopes: readonly AgentToolScope[] = ['tool:posts.index']
      instructions = 'x'
      override tools() {
        return this.appTools(['posts.index', 'posts.store', 'posts.nope'])
      }
    }

    expect(() => ai.agent(Confused).as({ id: 1 })).toThrow(/"posts\.store" is not granted[\s\S]*"posts\.nope"/)
  })

  test('should refuse a write tool for an anonymous run', () => {
    expect(() => ai.agent(Writer).as(null)).toThrow(/"posts\.store" is not declared read-only, and this run is as\(null\)/)
  })

  test('should refuse a scope entry outside the grammar', () => {
    class Misspelled extends Agent {
      static override scopes = ['posts.index'] as unknown as readonly AgentToolScope[]
      instructions = 'x'
      override tools() {
        return this.appTools([])
      }
    }

    expect(() => ai.agent(Misspelled).as({ id: 1 })).toThrow(/"posts\.index" is not in the scope grammar/)
  })

  test('should not cache the tool list before the application has finished booting', async () => {
    const late = definePlugin({
      name: 'late-routes',
      register() {},
      boot(container) {
        const app = container.make('app')
        // An agent built mid-boot sees the routes as they are now...
        expect(() => container.make('ai').agent(Late).as({ id: 1 })).toThrow(/no route derives the tool "late_tool"/)
        app.router.get('/late', () => Response.json({ late: true })).name('late_tool').agent({ description: 'Late' })
      },
    })
    const h2 = await bootHarness({ after: [late()] })

    // ...and one built after boot sees the route registered later in it.
    expect(() => h2.app.container.make('ai').agent(Late).as({ id: 1 })).not.toThrow()
  })

  test('should name aiPlugin() when the plugin is not registered', async () => {
    const bare = await bootHarness({ plugin: false })

    expect(() => bare.app.container.make('ai').agent(Reader).as({ id: 1 })).toThrow(/aiPlugin\(\)/)
  })
})

describe('aiPlugin: audit resolution', () => {
  test('should record into its own sink when given one', async () => {
    const lines: unknown[] = []
    const own = await bootHarness({ plugin: { audit: { sink: (record) => void lines.push(record) } } })
    own.script([{ toolCalls: [{ name: 'posts.index', input: {} }] }, { text: 'ok' }])

    await own.app.container.make('ai').agent(Reader).as({ id: 1 }).prompt('Read.')
    await drainEvents()

    expect(lines).toMatchObject([{ surface: 'in-process', tool: 'posts.index', outcome: 'invoked' }])
  })

  test('should record into the published agent.audit binding when it has none of its own', async () => {
    const lines: unknown[] = []
    const shared = await bootHarness({ providers: [mcpPlugin({ audit: { sink: (record) => void lines.push(record) } })] })
    shared.script([{ toolCalls: [{ name: 'posts.index', input: {} }] }, { text: 'ok' }])

    await shared.app.container.make('ai').agent(Reader).as({ id: 1 }).prompt('Read.')
    await drainEvents()

    expect(lines).toMatchObject([{ surface: 'in-process', tool: 'posts.index' }])
  })

  test('should refuse a trail configured on both plugins, at first use rather than at boot', async () => {
    // Boots without complaint whichever order the providers are in.
    const twice = await bootHarness({
      plugin: { audit: { sink: () => {} } },
      providers: [mcpPlugin({ audit: { sink: () => {} } })],
    })

    expect(() => twice.app.container.make('ai').agent(Reader).as({ id: 1 })).toThrow(
      /aiPlugin\(\{ audit \}\) and mcpPlugin\(\{ audit \}\)/,
    )
  })

  test('should refuse an approval-gated tool fail-closed, naming aiPlugin, when no queue is configured', async () => {
    const unqueued = await bootHarness()
    unqueued.script([{ toolCalls: [{ name: 'posts.publish', input: { id: 3 } }] }, { text: 'ok' }])

    const response = await unqueued.app.container.make('ai').agent(Writer).as({ id: 1 }).prompt('Publish.')

    const output = onlyOutput<{ denied: string; message: string }>(response)
    expect(output.denied).toBe('approval')
    expect(output.message).toContain('aiPlugin({ approvals: { store, notify } })')
  })

})
