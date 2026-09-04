import { describe, test, expect, beforeEach, afterEach, spyOn, type Mock } from 'bun:test'

import { createAuditEmitter } from './audit-emitter'
import { AgentToolDenied, AgentToolInvoked } from './events'
import type { AgentAuditRecord } from './audit'
import { EventManager } from '../events'

/**
 * The audit sink, driven through {@link createAuditEmitter} rather than by
 * emitting an event — that *is* the design: `EventManager.emit` awaits
 * listeners in a bare `for` loop, so while the sink was a listener one
 * unrelated thrower above it took the trail with it.
 *
 * Imported relatively, never through `@guren/core`: inside `packages/server` a
 * `@guren/core` import resolves back through this package's own `dist`, so
 * these cases would exercise the last build rather than the source beside them.
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
 * One turn of the event loop. The emitter answers before its work finishes — a
 * tool call may not wait on its own audit record — so an assertion about a
 * rejected sink is behind at least one macrotask. `await Promise.resolve()` is
 * not enough: a rejection routes through a `.catch` of its own.
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
    // order inside a bare `for` loop, so the first to throw ends the loop.
    // While the sink was a listener, any application listener registered above
    // it could silence the audit trail, with an empty file as the only evidence.
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
