import { describe, test, expect, afterEach } from 'bun:test'
import { z } from 'zod'
import {
  AGENT_AUDIT_BINDING,
  AgentToolInvoked,
  EventServiceProvider,
  createApp,
  definePlugin,
  type AgentAuditEmitter,
  type AgentAuditRecord,
  type Application,
  type Router,
} from '@guren/core'

// A devDependency, so that one test pairs this plugin with the *real* other
// publisher of the audit binding — a stand-in would keep passing if `mcpPlugin`
// changed when it binds. devDeps are not build edges, so this reads plugin-mcp
// through a `dist` that builds later: fine after `bun run build`.
import { mcpPlugin } from '@guren/plugin-mcp'

import { agentsPlugin } from './plugin'
import { resetAgentRuntime, resolveAgentRuntime } from './latch'
import { createAgentToolClient } from './tool-client'

/**
 * What `agentsPlugin`'s `boot` settles once for the whole isolate.
 *
 * Its own file because every case clears the module-level runtime latch, and a
 * suite sharing a fixture could not say which of the two left it as found.
 * `tool-client.test.ts` owns the fixture; this file owns the latch.
 */

function registerRoutes(router: Router): void {
  router
    .get('/posts', () => Response.json({ posts: [] }))
    .name('posts.index')
    .agent({ description: 'List posts' })

  router
    .post('/posts', { body: z.object({ title: z.string() }) }, () => Response.json({ ok: true }))
    .name('posts.store')
    .agent({ description: 'Create a post' })
}

/**
 * The registry most cases here need: one agent, scoped to the one read tool
 * `registerRoutes` declares. Spelled once so a case that varies the scopes or
 * the provider order says so by differing from this.
 */
const TRIAGER = {
  triager: { module: 'app/Agents/Triager.ts', export: 'Triager', scopes: ['tool:posts.index'] },
}

async function boot(
  config: Parameters<typeof agentsPlugin>[0],
  extraProviders: Application['options']['providers'] = [],
): Promise<Application> {
  const app = createApp({
    routes: registerRoutes,
    providers: [...(extraProviders ?? []), agentsPlugin(config)],
  })
  await app.boot()
  return app
}

/** Capture `console.warn` for the duration of one call. */
async function captureWarnings(run: () => Promise<void>): Promise<string[]> {
  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '))
  }
  try {
    await run()
  } finally {
    console.warn = original
  }
  return warnings
}

afterEach(() => {
  resetAgentRuntime()
})

describe('agentsPlugin', () => {
  test('should not dispatch into an application whose boot failed after the runtime was published', async () => {
    const explode = definePlugin({
      name: 'explode',
      register(): void {},
      async boot(): Promise<void> {
        throw new Error('later provider failed')
      },
    })
    const app = createApp({
      routes: registerRoutes,
      providers: [agentsPlugin({ agents: TRIAGER }), explode()],
    })
    await expect(app.boot()).rejects.toThrow('later provider failed')

    // The runtime was published before the later provider threw and outlives
    // the failure. A dispatch through it retries the boot — and fails the same
    // way — rather than entering the half-assembled application.
    const runtime = await resolveAgentRuntime()
    await expect(runtime.app.fetch(new Request('http://agents.test/posts'))).rejects.toThrow(
      'later provider failed',
    )
  })

  test('should publish a runtime whose registrations are keyed by export name', async () => {
    await boot({ agents: TRIAGER })

    const runtime = await resolveAgentRuntime()
    // Export name, because that is the only identity a Durable Object class
    // carries at runtime.
    expect([...runtime.registrations.keys()]).toEqual(['Triager'])
    expect(runtime.registrations.get('Triager')).toEqual({
      name: 'triager',
      abilities: ['tool:posts.index'],
    })
  })

  test('should expand tools:read against the booted route graph', async () => {
    await boot({
      agents: { reader: { module: 'app/Agents/Reader.ts', export: 'Reader', scopes: ['tools:read'] } },
    })

    const runtime = await resolveAgentRuntime()
    expect(runtime.registrations.get('Reader')?.abilities).toEqual(['tool:posts.index'])
  })

  test('should refuse to boot on an unregistrable scope, naming the agent', async () => {
    const app = createApp({
      routes: registerRoutes,
      providers: [
        agentsPlugin({
          agents: { greedy: { module: 'app/Agents/Greedy.ts', export: 'Greedy', scopes: ['tools:*'] } },
        }),
      ],
    })

    await expect(app.boot()).rejects.toThrow(/agents\.greedy/)
  })

  test('should warn — not throw — about a scope naming a tool no route declares', async () => {
    // A route can be registered by a plugin that boots after this one, so
    // refusing to boot would make provider order a correctness question. The
    // scope gate is fail-closed either way: the ability grants nothing.
    const warnings = await captureWarnings(async () => {
      await boot({
        agents: {
          triager: {
            module: 'app/Agents/Triager.ts',
            export: 'Triager',
            scopes: ['tool:posts.index', 'tool:posts.destroy'],
          },
        },
      })
    })

    expect(warnings.join('\n')).toContain('"posts.destroy"')
    expect(warnings.join('\n')).toContain('grants nothing')

    const runtime = await resolveAgentRuntime()
    expect(runtime.registrations.get('Triager')?.abilities).toEqual(['tool:posts.index'])
  })

  test('should not dispatch into the application until its boot has finished', async () => {
    // `agentsPlugin.boot` runs inside `bootAll()`, so every provider after it
    // is still unbooted when the runtime is published. A tool call taken at
    // that instant would re-enter a half-assembled app.
    const order: string[] = []
    let dispatched = false

    const latePlugin = definePlugin({
      name: 'late',
      register(): void {},
      async boot(): Promise<void> {
        // Racing the app's own boot, exactly as an alarm would.
        void resolveAgentRuntime()
          .then((runtime) =>
            createAgentToolClient({ runtime, agentName: 'triager', instanceId: 'race' })
              .call('posts.index', {}))
          .then(() => {
            dispatched = true
            order.push('dispatch')
          })
        await new Promise((settle) => setTimeout(settle, 5))
        order.push('late-provider-booted')
      },
    })

    const app = createApp({
      routes: registerRoutes,
      providers: [agentsPlugin({ agents: TRIAGER }), latePlugin()],
    })
    await app.boot()
    expect(dispatched).toBe(false)

    await new Promise((settle) => setTimeout(settle, 20))
    expect(dispatched).toBe(true)
    expect(order).toEqual(['late-provider-booted', 'dispatch'])
  })

  test('should boot a second application without refusing the first', async () => {
    // The ordinary case: an application's own Bun suite creating a `TestApp`
    // per file. `agentsPlugin.boot` mints a fresh runtime object each time, so
    // the runtime slot must be last-publish-wins rather than refuse one.
    await boot({ agents: TRIAGER })
    await boot({ agents: TRIAGER })

    const runtime = await resolveAgentRuntime()
    expect(runtime.registrations.get('Triager')?.abilities).toEqual(['tool:posts.index'])
  })

  test('should record into an audit binding published by a plugin that boots after it', async () => {
    // The regression this exists for. `mcpPlugin` publishes AGENT_AUDIT_BINDING
    // from its *own* boot, so in this provider order there is no binding at the
    // instant `agentsPlugin` boots. Resolving the emitter there left the
    // durable surface writing to nowhere for the life of the process, decided
    // by the order of two lines in an array, with no error anywhere.
    const records: AgentAuditRecord[] = []
    const app = createApp({
      routes: registerRoutes,
      providers: [
        EventServiceProvider,
        agentsPlugin({ agents: TRIAGER }),
        // Deliberately *after* agentsPlugin.
        mcpPlugin({ audit: { sink: (record) => { records.push(record) } } }),
      ],
    })
    await app.boot()

    const runtime = await resolveAgentRuntime()
    await createAgentToolClient({ runtime, agentName: 'triager', instanceId: 'i-1' })
      .call('posts.index', {})

    expect(records.map((record) => `${record.tool}:${record.surface}`)).toEqual(['posts.index:durable'])
  })

  test('should record into the audit emitter another surface already published', async () => {
    // The binding is how `guren tool:call` and the MCP endpoint share one
    // trail. A plugin that built its own emitter beside it would be a second
    // audit configuration the application never asked for.
    const recorded: string[] = []
    const emitter: AgentAuditEmitter = (event) => {
      recorded.push(`${event.constructor.name}:${event.tool}`)
    }

    const app = createApp({
      routes: registerRoutes,
      providers: [
        EventServiceProvider,
        agentsPlugin({ agents: TRIAGER }),
      ],
    })
    app.container.instance(AGENT_AUDIT_BINDING, emitter)
    await app.boot()

    const runtime = await resolveAgentRuntime()
    expect(runtime.audit?.()).toBe(emitter)

    await createAgentToolClient({ runtime, agentName: 'triager', instanceId: 'i-1' })
      .call('posts.index', {})

    expect(recorded).toEqual([`${AgentToolInvoked.name}:posts.index`])
  })
})
