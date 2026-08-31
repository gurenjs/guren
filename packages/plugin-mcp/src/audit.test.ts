import { describe, test, expect, beforeEach, afterEach, spyOn, type Mock } from 'bun:test'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AgentToolDenied,
  AgentToolInvoked,
  EventManager,
  EventServiceProvider,
  createApp,
  dailyFilePath,
  parseAuditRecord,
  type AgentAuditRecord,
  type Application,
  type EventManager as EventManagerType,
  type Router,
} from '@guren/core'

import { createAuditEmitter } from './audit-emitter'
import { createFileAuditSink } from './audit-file'
import { mcpPlugin } from './plugin'

/**
 * The audit sink, driven through {@link createAuditEmitter} rather than by
 * emitting an event.
 *
 * That is not a shortcut around the design — it *is* the design. The sink used
 * to be an ordinary listener, and a listener is only ever called if every
 * higher-priority listener before it returned; `EventManager.emit` awaits them
 * in a bare `for` loop with no try/catch, so one unrelated application listener
 * throwing ends the loop and the audit trail goes quiet. The emitter calls the
 * sink itself for that reason, and these tests drive the thing that decides.
 *
 * `plugin.test.ts` already covers that a real MCP call reaches this emitter;
 * proving what the emitter then does needs no endpoint.
 */

/** Future-seeded, like the server-side fixtures: a past epoch expires everything. */
const NOW = new Date('2087-03-14T01:59:26.535Z')

const INVOKED = new AgentToolInvoked(
  { kind: 'user', id: 42 },
  'posts.index',
  // Already through `redactAgentArguments` by the time an emitter sees it —
  // the mask below was applied there, and the visible value was deliberately
  // left visible there. Neither may be touched again on the way to a sink.
  { page: 2, token: '[redacted]' },
  200,
  12,
  'mcp',
)
const DENIED = new AgentToolDenied({ kind: 'user', id: 42 }, 'posts.store', { title: 'x' }, 'scope', 'mcp')

/**
 * One turn of the event loop.
 *
 * The emitter answers before its work finishes — a tool call may not wait on
 * its own audit record — so an assertion about a rejected sink or about what a
 * listener saw is behind at least one macrotask. `await Promise.resolve()` is
 * not: `emit` awaits each listener, and a rejection routes through a `.catch`
 * of its own.
 */
function flush(): Promise<void> {
  return new Promise((done) => setTimeout(done, 0))
}

describe('the audit emitter', () => {
  // Captured for every case, not only the ones asserting a warning: several
  // here assert that nothing was warned, which is only a claim if the spy was
  // installed before the emitter ran.
  let warn: Mock<typeof console.warn>

  beforeEach(() => {
    warn = spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warn.mockRestore()
  })

  function warnings(): string {
    return warn.mock.calls.flat().map(String).join('\n')
  }

  test('should hand the sink a record for an invocation and for a denial', async () => {
    const records: AgentAuditRecord[] = []
    const emit = createAuditEmitter((record) => void records.push(record), new EventManager(), () => NOW)

    emit(INVOKED)
    emit(DENIED)
    await flush()

    expect(records).toEqual([
      {
        ts: '2087-03-14T01:59:26.535Z',
        outcome: 'invoked',
        surface: 'mcp',
        tool: 'posts.index',
        principal: { kind: 'user', id: 42 },
        // Carried across verbatim: the mask is the emitter's, and a sink that
        // masked again would be a second redaction rule nothing reading a
        // record could tell apart from the real one.
        arguments: { page: 2, token: '[redacted]' },
        status: 200,
        durationMs: 12,
      },
      {
        ts: '2087-03-14T01:59:26.535Z',
        outcome: 'denied',
        surface: 'mcp',
        tool: 'posts.store',
        principal: { kind: 'user', id: 42 },
        arguments: { title: 'x' },
        reason: 'scope',
      },
    ])
    // A denial refused before any HTTP happened, so there is no status it
    // could honestly report.
    expect(records[1]).not.toHaveProperty('status')
  })

  test('should still record when a higher-priority listener throws', async () => {
    // The regression. `EventManager.emit` awaits its listeners in priority
    // order inside a bare `for` loop, so the first to throw ends the loop and
    // nothing after it runs. While the sink was a listener, any application
    // listener registered above it could silence the audit trail — and the
    // only evidence of that would have been an empty file. A record of what
    // agents did may not be contingent on what else the application listens
    // for.
    const events = new EventManager()
    const records: AgentAuditRecord[] = []
    const listenerRan: string[] = []

    events.on(AgentToolInvoked, () => {
      throw new Error('an unrelated application listener exploded')
    }, { priority: 100 })
    events.on(AgentToolInvoked, () => void listenerRan.push('below'), { priority: -100 })

    createAuditEmitter((record) => void records.push(record), events, () => NOW)(INVOKED)
    await flush()

    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ outcome: 'invoked', tool: 'posts.index' })
    // The starvation itself, asserted rather than assumed: a listener below the
    // thrower genuinely never runs. Without this the test above could pass on a
    // manager that isolated listener failures, and would prove nothing.
    expect(listenerRan).toEqual([])
    // The listener failure is reported, not swallowed — it just cannot take the
    // record with it.
    expect(warnings()).toContain('audit event listener failed')
  })

  test('should record with no event manager bound at all', async () => {
    // An application that registered no `EventServiceProvider` still gets its
    // trail. The sink's delivery does not run through the event system, so
    // there is nothing here for a missing event manager to break.
    const records: AgentAuditRecord[] = []
    const emit = createAuditEmitter((record) => void records.push(record), undefined, () => NOW)

    emit(INVOKED)
    emit(DENIED)
    await flush()

    expect(records.map((record) => record.tool)).toEqual(['posts.index', 'posts.store'])
    expect(warnings()).toBe('')
  })

  test('should warn and not throw when the sink throws synchronously', async () => {
    const emit = createAuditEmitter(() => {
      throw new Error('sink exploded')
    }, new EventManager(), () => NOW)

    // The emitter is called on the tool call's own path: a sink's failure may
    // not fail the call it was recording.
    expect(() => emit(INVOKED)).not.toThrow()
    await flush()

    // And it must be said out loud. A sink dropping records in silence is the
    // exact failure this feature exists to prevent.
    expect(warnings()).toContain('agent audit sink failed, record dropped')
    expect(warnings()).toContain('sink exploded')
  })

  test('should warn and not reject when the sink returns a rejected promise', async () => {
    const emit = createAuditEmitter(() => Promise.reject(new Error('delivery refused')), new EventManager(), () => NOW)

    expect(() => emit(INVOKED)).not.toThrow()
    await flush()

    expect(warnings()).toContain('agent audit sink failed, record dropped')
    expect(warnings()).toContain('delivery refused')
  })

  test('should emit the events with no sink configured', async () => {
    const events = new EventManager()
    const seen: string[] = []
    events.on(AgentToolInvoked, (event) => void seen.push(event.tool))
    events.on(AgentToolDenied, (event) => void seen.push(event.tool))

    const emit = createAuditEmitter(undefined, events, () => NOW)
    emit(INVOKED)
    emit(DENIED)
    await flush()

    // RFC 0016 §5.2's "forward them wherever you already forward events" is
    // untouched by the sink existing or not.
    expect(seen).toEqual(['posts.index', 'posts.store'])
    expect(warnings()).toBe('')
  })
})

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

      // Counted rather than inferred from the absence of a warning: the old
      // assertion was that nothing warned, which held whether or not a
      // listener had been registered. This is the property the starvation fix
      // actually turns on.
      expect(events.listenerCount(AgentToolInvoked)).toBe(0)
      expect(events.listenerCount(AgentToolDenied)).toBe(0)
    } finally {
      warn.mockRestore()
    }
  })
})

describe('the file audit sink', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function tempBasePath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'guren-mcp-audit-'))
    dirs.push(dir)
    return join(dir, 'agent-audit.log')
  }

  /** The dated file the sink's records landed in, line by line. */
  function writtenLines(basePath: string, at: Date): string[] {
    return readFileSync(dailyFilePath(basePath, at), 'utf8').split('\n').filter((line) => line !== '')
  }

  test('should append records as JSONL the reader parses back', () => {
    // Through the real `DailyFileChannel` and the real files on disk. The sink
    // reuses the channel rather than appending itself, so what a reader has to
    // cope with is the channel's line format — and a mock would let that change
    // without anything noticing.
    const basePath = tempBasePath()
    const sink = createFileAuditSink(basePath, 30)

    const emit = createAuditEmitter(sink, undefined, () => NOW)
    emit(INVOKED)
    emit(DENIED)

    expect(writtenLines(basePath, NOW).map(parseAuditRecord)).toEqual([
      {
        ts: '2087-03-14T01:59:26.535Z',
        outcome: 'invoked',
        surface: 'mcp',
        tool: 'posts.index',
        principal: { kind: 'user', id: 42 },
        arguments: { page: 2, token: '[redacted]' },
        status: 200,
        durationMs: 12,
      },
      {
        ts: '2087-03-14T01:59:26.535Z',
        outcome: 'denied',
        surface: 'mcp',
        tool: 'posts.store',
        principal: { kind: 'user', id: 42 },
        arguments: { title: 'x' },
        reason: 'scope',
      },
    ])
  })

  test('should survive arguments named after the log envelope’s own fields', () => {
    // The channel's JSON format writes `{ timestamp, level, message,
    // ...context }`, and the record rides in `context`. An argument called
    // `timestamp` therefore sits one level down, inside the record's
    // `arguments`, and cannot displace the envelope's — but nothing said so
    // until now, and a sink that spread the record's arguments at the top level
    // instead would overwrite the envelope with attacker-chosen values and read
    // back as a different record entirely.
    const basePath = tempBasePath()
    const args = { level: 'error', message: 'not the envelope’s', timestamp: '1999-12-31T00:00:00.000Z' }
    const event = new AgentToolInvoked({ kind: 'user', id: 7 }, 'posts.store', args, 201, 3, 'cli')

    createAuditEmitter(createFileAuditSink(basePath, 30), undefined, () => NOW)(event)

    const [line] = writtenLines(basePath, NOW)
    expect(parseAuditRecord(line)?.arguments).toEqual(args)
    // And the envelope still reports the record's instant, not an argument's.
    // Read off the raw line, because `parseAuditRecord` discards the envelope
    // and so could never show this.
    const envelope = JSON.parse(line) as Record<string, unknown>
    expect(envelope.timestamp).toBe('2087-03-14T01:59:26.535Z')
    expect(envelope.level).toBe('info')
    expect(envelope.message).toBe('agent.audit')
    expect(parseAuditRecord(line)?.ts).toBe('2087-03-14T01:59:26.535Z')
  })
})
