import { describe, test, expect, spyOn } from 'bun:test'
import {
  AgentToolDenied,
  AgentToolInvoked,
  EventServiceProvider,
  createApp,
  type AgentAuditEmitter,
  type Application,
  type EventManager as EventManagerType,
  type Router,
} from '@guren/core'

import { mcpPlugin } from './plugin'
import { callToolOverSeam, recordingExecutionContext } from './seam-tool-call'

/**
 * What this endpoint does *with* the emitter: it registers no listener and
 * publishes the emitter for other surfaces. The emitter's own rules and the file
 * sink live beside them in `packages/server/src/agent/`.
 */

describe('the audit sink through the plugin', () => {
  function registerRoutes(router: Router): void {
    router
      .get('/posts', () => Response.json({ posts: [] }))
      .name('posts.index')
      .agent({ description: 'List posts' })
  }

  test('should install no event listener, even with a sink configured', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const app: Application = createApp({
        routes: registerRoutes,
        providers: [EventServiceProvider, mcpPlugin({ audit: { sink: () => {} } })],
      })
      await app.boot()
      const events = app.container.make<EventManagerType>('events')

      // Counted rather than inferred from the absence of a warning, which held
      // whether or not a listener had been registered.
      expect(events.listenerCount(AgentToolInvoked)).toBe(0)
      expect(events.listenerCount(AgentToolDenied)).toBe(0)
    } finally {
      warn.mockRestore()
    }
  })

  test('should publish the emitter so another surface records into the same trail', async () => {
    // The seam `guren tool:call` reaches across: it cannot import this package,
    // so it resolves a container name, which the boot that resolved the sink has
    // to have bound, carrying that sink.
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const records: string[] = []
      const app: Application = createApp({
        routes: registerRoutes,
        providers: [
          EventServiceProvider,
          mcpPlugin({ audit: { sink: (record) => void records.push(`${record.surface}:${record.tool}`) } }),
        ],
      })
      await app.boot()

      const emit = app.container.make<AgentAuditEmitter>('agent.audit')
      // A `'cli'` event on purpose: the binding is *for* a surface other than
      // this endpoint, whose records must land in this application's sink.
      emit(new AgentToolInvoked({ kind: 'user', id: 7 }, 'posts.index', {}, 200, 1, 'cli'))

      expect(records).toEqual(['cli:posts.index'])
    } finally {
      warn.mockRestore()
    }
  })

  test('should hand a slow sink to the request\'s waitUntil', async () => {
    // On workerd an unawaited sink promise is abandoned when the request
    // context closes, silently — see the workerd test beside this file. The
    // endpoint has the execution context; the boot-time emitter never did.
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const records: string[] = []
      // Every resolver, not the latest: a second record would otherwise leave
      // the first promise pending and hang the test instead of failing it.
      const release: (() => void)[] = []
      const app: Application = createApp({
        routes: registerRoutes,
        providers: [
          EventServiceProvider,
          mcpPlugin({
            auth: 'external',
            audit: {
              sink: (record) =>
                new Promise<void>((done) => {
                  release.push(() => {
                    records.push(record.tool)
                    done()
                  })
                }),
            },
          }),
        ],
      })
      await app.boot()

      const deferred: Promise<unknown>[] = []
      await callToolOverSeam(app, { tool: 'posts.index', executionCtx: recordingExecutionContext(deferred) })

      // Still pending when the response was produced: exactly the promise that
      // is lost without `waitUntil`, and the reason the call may not await it.
      expect(records).toEqual([])
      expect(deferred.length).toBeGreaterThan(0)

      for (const done of release) done()
      await Promise.all(deferred)
      expect(records).toEqual(['posts.index'])
    } finally {
      warn.mockRestore()
    }
  })

  test('should record with no execution context, as on Bun', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const records: string[] = []
      const app: Application = createApp({
        routes: registerRoutes,
        providers: [
          EventServiceProvider,
          mcpPlugin({ auth: 'external', audit: { sink: (record) => void records.push(record.tool) } }),
        ],
      })
      await app.boot()

      const result = await callToolOverSeam(app, { tool: 'posts.index' })

      expect(result.isError).toBeUndefined()
      expect(records).toEqual(['posts.index'])
      expect(warn.mock.calls.flat().map(String).join('\n')).not.toContain('could not be deferred')
    } finally {
      warn.mockRestore()
    }
  })

  test('should record through a context with no callable waitUntil', async () => {
    // `c.executionCtx` is a cast, not a check. A partial context must not turn
    // the tool call into a 500 — a trail may not fail what it records.
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const records: string[] = []
      const app: Application = createApp({
        routes: registerRoutes,
        providers: [
          EventServiceProvider,
          mcpPlugin({ auth: 'external', audit: { sink: (record) => void records.push(record.tool) } }),
        ],
      })
      await app.boot()

      await callToolOverSeam(app, { tool: 'posts.index', executionCtx: { passThroughOnException: () => {} } })

      expect(records).toEqual(['posts.index'])
    } finally {
      warn.mockRestore()
    }
  })

  test('should publish no emitter when no sink is configured', async () => {
    // The binding means "there is somewhere to write". Bound unconditionally, a
    // one-shot `guren tool:call` would resolve it, run the application's
    // listeners in a process about to exit, and still write nothing.
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const app: Application = createApp({
        routes: registerRoutes,
        providers: [EventServiceProvider, mcpPlugin()],
      })
      await app.boot()

      expect(app.container.has('agent.audit')).toBe(false)
    } finally {
      warn.mockRestore()
    }
  })
})
