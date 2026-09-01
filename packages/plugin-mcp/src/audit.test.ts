import { describe, test, expect, afterEach, spyOn } from 'bun:test'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AgentToolDenied,
  AgentToolInvoked,
  EventServiceProvider,
  createApp,
  createAuditEmitter,
  dailyFilePath,
  parseAuditRecord,
  type AgentAuditEmitter,
  type Application,
  type EventManager as EventManagerType,
  type Router,
} from '@guren/core'

import { createFileAuditSink } from './audit-file'
import { mcpPlugin } from './plugin'

/**
 * What this endpoint does *with* the emitter, plus the file sink it can build.
 *
 * The emitter's own rules — sink before listeners, a throwing listener that
 * cannot starve the trail, a throwing sink that cannot fail the call — live
 * with the emitter, in `packages/server/src/agent/audit-emitter.test.ts`. It
 * moved there when `guren tool:call` became its second reader, and a copy of
 * those cases here would only re-assert them across a package boundary. What
 * is genuinely this package's is below: that the plugin registers no listener,
 * that it publishes the emitter for other surfaces, and that the file sink
 * writes lines the reader parses back.
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

  test('should publish the emitter so another surface records into the same trail', async () => {
    // The seam `guren tool:call` reaches across. That command cannot import
    // this package, so what it resolves is a container name — and the name has
    // to be bound by the boot that resolved the sink, carrying that sink.
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
      // Driven with a `'cli'` event on purpose: what the binding is *for* is a
      // surface other than this endpoint, and a record it produces must land
      // in the sink this application configured.
      emit(new AgentToolInvoked({ kind: 'user', id: 7 }, 'posts.index', {}, 200, 1, 'cli'))

      expect(records).toEqual(['cli:posts.index'])
    } finally {
      warn.mockRestore()
    }
  })

  test('should publish no emitter when no sink is configured', async () => {
    // The binding means "there is somewhere to write". Bound unconditionally,
    // a one-shot `guren tool:call` would resolve it, run the application's
    // listeners in a process about to exit, and still write nothing — an
    // absent trail that looks configured from the outside.
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
