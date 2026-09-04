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
 * What this endpoint does *with* the emitter, plus the file sink it can build;
 * the emitter's own rules live in `packages/server/src/agent/audit-emitter.test.ts`.
 * Genuinely this package's: the plugin registers no listener, publishes the
 * emitter for other surfaces, and the file sink writes lines the reader parses back.
 */

/** Future-seeded, like the server-side fixtures: a past epoch expires everything. */
const NOW = new Date('2087-03-14T01:59:26.535Z')

const INVOKED = new AgentToolInvoked(
  { kind: 'user', id: 42 },
  'posts.index',
  // Already through `redactAgentArguments` by the time an emitter sees it:
  // neither the mask nor the visible value may be touched again on the way out.
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
    // Through the real `DailyFileChannel` and real files on disk: the sink reuses
    // the channel rather than appending itself, so what a reader copes with is
    // the channel's line format, which a mock would let change unnoticed.
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
    // ...context }` and the record rides in `context`, so an argument called
    // `timestamp` sits one level down and cannot displace the envelope's. A sink
    // spreading the record's arguments at the top level instead would let
    // attacker-chosen values overwrite it.
    const basePath = tempBasePath()
    const args = { level: 'error', message: 'not the envelope’s', timestamp: '1999-12-31T00:00:00.000Z' }
    const event = new AgentToolInvoked({ kind: 'user', id: 7 }, 'posts.store', args, 201, 3, 'cli')

    createAuditEmitter(createFileAuditSink(basePath, 30), undefined, () => NOW)(event)

    const [line] = writtenLines(basePath, NOW)
    expect(parseAuditRecord(line)?.arguments).toEqual(args)
    // And the envelope still reports the record's instant, not an argument's.
    // Read off the raw line: `parseAuditRecord` discards the envelope.
    const envelope = JSON.parse(line) as Record<string, unknown>
    expect(envelope.timestamp).toBe('2087-03-14T01:59:26.535Z')
    expect(envelope.level).toBe('info')
    expect(envelope.message).toBe('agent.audit')
    expect(parseAuditRecord(line)?.ts).toBe('2087-03-14T01:59:26.535Z')
  })
})
