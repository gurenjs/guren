import { describe, test, expect, beforeAll, afterEach, spyOn, type Mock } from 'bun:test'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import {
  AgentToolDenied,
  AgentToolInvoked,
  EventServiceProvider,
  createApp,
  dailyFilePath,
  parseAuditRecord,
  type AgentAuditRecord,
  type Application,
  type EventManager,
  type Router,
} from '@guren/core'

import { mcpPlugin } from './plugin'

/**
 * The audit sink, driven by emitting the events themselves rather than through
 * a tool call.
 *
 * That is the point of the design, not a shortcut around it: the sink is wired
 * as an ordinary event listener (RFC 0016 §5.2), so what it receives is
 * whatever any listener receives. `plugin.test.ts` already covers that a real
 * MCP call emits these; testing the sink against a hand-made event is what
 * keeps the two concerns from having to be proved together.
 */
function registerRoutes(router: Router): void {
  router
    .get('/posts', () => Response.json({ posts: [] }))
    .name('posts.index')
    .agent({ description: 'List posts' })
}

async function bootWith(audit: Parameters<typeof mcpPlugin>[0]): Promise<EventManager> {
  const app: Application = createApp({
    routes: registerRoutes,
    providers: [EventServiceProvider, mcpPlugin(audit)],
  })
  await app.boot()
  return app.container.make<EventManager>('events')
}

const INVOKED = new AgentToolInvoked({ kind: 'user', id: 42 }, 'posts.index', { page: 2 }, 200, 12, 'mcp')
const DENIED = new AgentToolDenied({ kind: 'user', id: 42 }, 'posts.store', { title: 'x' }, 'scope', 'mcp')

describe('the audit sink', () => {
  let warn: Mock<typeof console.warn>

  afterEach(() => {
    warn.mockRestore()
  })

  function captureWarnings(): void {
    warn = spyOn(console, 'warn').mockImplementation(() => {})
  }

  test('should hand a configured sink a record for an invocation and for a denial', async () => {
    captureWarnings()
    const records: AgentAuditRecord[] = []
    const events = await bootWith({ audit: { sink: (record) => void records.push(record) } })

    await events.emit(INVOKED)
    await events.emit(DENIED)

    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({
      outcome: 'invoked',
      tool: 'posts.index',
      surface: 'mcp',
      status: 200,
      durationMs: 12,
      arguments: { page: 2 },
      principal: { kind: 'user', id: 42 },
    })
    expect(records[1]).toMatchObject({ outcome: 'denied', tool: 'posts.store', reason: 'scope' })
    expect(typeof records[0].ts).toBe('string')
  })

  test('should warn and not fail the call when the sink throws', async () => {
    captureWarnings()
    const events = await bootWith({
      audit: {
        sink: () => {
          throw new Error('sink exploded')
        },
      },
    })

    // The emit itself must resolve: a listener's failure may not fail the tool
    // call it was recording.
    await events.emit(INVOKED)

    // And it must be said out loud. The event manager isolates listener
    // errors, which means it swallows them — a sink dropping records in
    // silence is the failure this whole feature exists to prevent.
    expect(warn.mock.calls.flat().join('\n')).toContain('agent audit sink failed, record dropped')
  })

  test('should warn when the sink rejects asynchronously', async () => {
    captureWarnings()
    const events = await bootWith({ audit: { sink: () => Promise.reject(new Error('delivery refused')) } })

    await events.emit(INVOKED)
    await Promise.resolve()

    expect(warn.mock.calls.flat().join('\n')).toContain('delivery refused')
  })

  test('should warn that a configured sink will never receive anything with no event manager', async () => {
    captureWarnings()
    const app: Application = createApp({
      routes: registerRoutes,
      // No EventServiceProvider: nothing emits, so nothing reaches the sink.
      providers: [mcpPlugin({ audit: { sink: () => {} } })],
    })
    await app.boot()

    expect(warn.mock.calls.flat().join('\n')).toContain('audit sink is configured, but no event manager is bound')
  })

  test('should install no listener at all when audit is absent', async () => {
    captureWarnings()
    const events = await bootWith({})

    // The default is deliberately no sink: the framework must not begin
    // writing files on runtimes where that silently degrades. Events still
    // flow, which is what makes the sink one line of configuration.
    await events.emit(INVOKED)

    expect(warn.mock.calls.flat().join('\n')).not.toContain('agent audit sink failed')
  })
})

describe('the file audit sink', () => {
  const dirs: string[] = []
  let warn: Mock<typeof console.warn>

  beforeAll(() => {
    warn = spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  test('should append records as JSONL a reader can parse back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guren-mcp-audit-'))
    dirs.push(dir)
    const basePath = join(dir, 'agent-audit.log')
    const events = await bootWith({ audit: { file: basePath, days: 30 } })

    await events.emit(INVOKED)
    await events.emit(DENIED)

    const written = readFileSync(dailyFilePath(basePath, new Date()), 'utf8')
    const records = written.split('\n').map(parseAuditRecord).filter((record) => record !== null)

    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({ outcome: 'invoked', tool: 'posts.index', status: 200 })
    expect(records[1]).toMatchObject({ outcome: 'denied', tool: 'posts.store', reason: 'scope' })
    warn.mockClear()
  })
})
