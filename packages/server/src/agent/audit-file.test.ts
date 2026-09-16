import { describe, test, expect, afterEach } from 'bun:test'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseAuditRecord } from './audit'
import { createAuditEmitter } from './audit-emitter'
import { createFileAuditSink } from './audit-file'
import { resolveAgentAuditSink } from './audit-sink'
import { AgentToolDenied, AgentToolInvoked } from './events'
import { dailyFilePath } from '../logging/daily-file-path'

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

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempBasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'guren-agent-audit-'))
  dirs.push(dir)
  return join(dir, 'agent-audit.log')
}

/** The dated file the sink's records landed in, line by line. */
function writtenLines(basePath: string, at: Date): string[] {
  return readFileSync(dailyFilePath(basePath, at), 'utf8').split('\n').filter((line) => line !== '')
}

describe('createFileAuditSink', () => {
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
    expect(parseAuditRecord(line!)?.arguments).toEqual(args)
    // Read off the raw line: `parseAuditRecord` discards the envelope.
    const envelope = JSON.parse(line!) as Record<string, unknown>
    expect(envelope.timestamp).toBe('2087-03-14T01:59:26.535Z')
    expect(envelope.level).toBe('info')
    expect(envelope.message).toBe('agent.audit')
    expect(parseAuditRecord(line!)?.ts).toBe('2087-03-14T01:59:26.535Z')
  })
})

describe('resolveAgentAuditSink', () => {
  test('should hand back a configured sink as it is', async () => {
    const sink = () => {}
    expect(await resolveAgentAuditSink({ sink })).toBe(sink)
  })

  test('should build a file sink writing under the configured base path', async () => {
    const basePath = tempBasePath()
    const sink = await resolveAgentAuditSink({ file: basePath, days: 30 })

    createAuditEmitter(sink, undefined, () => NOW)(INVOKED)

    expect(writtenLines(basePath, NOW).map((line) => parseAuditRecord(line)?.tool)).toEqual(['posts.index'])
  })
})
