import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DailyFileChannel } from '../logging/channels/DailyFileChannel'
import { dailyFilePath } from '../logging/daily-file-path'
import { AgentToolDenied, AgentToolInvoked, type AgentPrincipal } from './events'
import { DEFAULT_AGENT_AUDIT_PATH, parseAuditRecord, toAuditRecord } from './audit'

/**
 * Seeded in the future rather than at a past epoch. A fake clock in the past
 * makes every retention and freshness rule pass by expiring everything, so a
 * test that was meant to prove a record survives proves nothing.
 */
const NOW = new Date('2087-03-14T01:59:26.535Z')

const PRINCIPAL: AgentPrincipal = { kind: 'user', id: 42, abilities: ['tools:read'] }

describe('toAuditRecord', () => {
  test('should record an invocation with its status and duration', () => {
    const event = new AgentToolInvoked(PRINCIPAL, 'posts.index', { page: 2 }, 200, 17, 'mcp')

    expect(toAuditRecord(event, NOW)).toEqual({
      ts: '2087-03-14T01:59:26.535Z',
      outcome: 'invoked',
      surface: 'mcp',
      tool: 'posts.index',
      principal: PRINCIPAL,
      arguments: { page: 2 },
      status: 200,
      durationMs: 17,
    })
  })

  test('should record a denial with its reason and no status', () => {
    const event = new AgentToolDenied(null, 'posts.store', { title: 'x' }, 'scope', 'webmcp')
    const record = toAuditRecord(event, NOW)

    expect(record).toEqual({
      ts: '2087-03-14T01:59:26.535Z',
      outcome: 'denied',
      surface: 'webmcp',
      tool: 'posts.store',
      principal: null,
      arguments: { title: 'x' },
      reason: 'scope',
    })
    expect(record).not.toHaveProperty('status')
    expect(record).not.toHaveProperty('durationMs')
  })

  test('should carry already-redacted arguments across without masking again', () => {
    // The emitter's contract (see the module header): a value the emitter chose
    // to leave visible must stay visible, or the sink has become a second
    // redaction rule.
    const event = new AgentToolInvoked(PRINCIPAL, 'posts.store', { password: 'kept-as-given' }, 201, 3, 'cli')

    expect(toAuditRecord(event, NOW).arguments).toEqual({ password: 'kept-as-given' })
  })

  test('should take its timestamp from the clock it is given, not the wall clock', () => {
    const event = new AgentToolInvoked(PRINCIPAL, 'posts.index', {}, 200, 1, 'mcp')

    expect(toAuditRecord(event, new Date('2099-01-01T00:00:00.000Z')).ts).toBe('2099-01-01T00:00:00.000Z')
  })
})

describe('parseAuditRecord', () => {
  test('should read back a record it wrote', () => {
    const record = toAuditRecord(new AgentToolInvoked(PRINCIPAL, 'posts.index', { page: 2 }, 200, 17, 'mcp'), NOW)

    expect(parseAuditRecord(JSON.stringify(record))).toEqual(record)
  })

  test('should return null for a truncated final line', () => {
    const line = JSON.stringify(toAuditRecord(new AgentToolInvoked(PRINCIPAL, 'posts.index', {}, 200, 1, 'mcp'), NOW))

    expect(parseAuditRecord(line.slice(0, line.length - 12))).toBeNull()
  })

  test('should return null for a blank line', () => {
    expect(parseAuditRecord('')).toBeNull()
    expect(parseAuditRecord('   \t ')).toBeNull()
  })

  test('should return null for JSON that is not a record', () => {
    expect(parseAuditRecord('{"hello":"world"}')).toBeNull()
    expect(parseAuditRecord('[1,2,3]')).toBeNull()
    expect(parseAuditRecord('null')).toBeNull()
    expect(parseAuditRecord('"a string"')).toBeNull()
  })

  test('should refuse an unknown surface or denial reason', () => {
    const denied = toAuditRecord(new AgentToolDenied(PRINCIPAL, 'posts.store', {}, 'scope', 'mcp'), NOW)

    expect(parseAuditRecord(JSON.stringify({ ...denied, surface: 'carrier-pigeon' }))).toBeNull()
    expect(parseAuditRecord(JSON.stringify({ ...denied, reason: 'vibes' }))).toBeNull()
  })

  test('should refuse a surface or reason that is only a prototype member', () => {
    // The membership test is `Object.hasOwn`, not `in`, and this is the whole
    // reason. `in` walks the prototype chain, so `"constructor"` and
    // `"toString"` are members of *every* object literal — a line naming one of
    // them would be read back as a genuine record, and the surface or reason it
    // reported would be a value the framework has never had. An audit trail is
    // exactly the file where a forged line must not read as real.
    const invoked = toAuditRecord(new AgentToolInvoked(PRINCIPAL, 'posts.index', {}, 200, 1, 'mcp'), NOW)
    const denied = toAuditRecord(new AgentToolDenied(PRINCIPAL, 'posts.store', {}, 'scope', 'mcp'), NOW)

    expect(parseAuditRecord(JSON.stringify({ ...invoked, surface: 'constructor' }))).toBeNull()
    expect(parseAuditRecord(JSON.stringify({ ...denied, reason: 'toString' }))).toBeNull()
    // The denial's own surface stays valid above, so this pins the `reason`
    // check rather than passing because the surface check already refused.
    expect(parseAuditRecord(JSON.stringify({ ...denied, surface: 'toString' }))).toBeNull()
  })

  test('should refuse an invocation missing its status or duration', () => {
    const invoked = toAuditRecord(new AgentToolInvoked(PRINCIPAL, 'posts.index', {}, 200, 1, 'mcp'), NOW)
    const withoutStatus: Record<string, unknown> = { ...invoked }
    delete withoutStatus.status

    expect(parseAuditRecord(JSON.stringify(withoutStatus))).toBeNull()
  })

  test('should keep the record when only the principal is unreadable', () => {
    // Losing the tool, the arguments and the outcome to recover nothing is the
    // wrong trade for an audit trail; who called is the one field allowed to
    // degrade on its own.
    const record = toAuditRecord(new AgentToolInvoked(PRINCIPAL, 'posts.index', { page: 1 }, 200, 5, 'mcp'), NOW)

    expect(parseAuditRecord(JSON.stringify({ ...record, principal: { kind: 'robot' } }))).toEqual({
      ...record,
      principal: null,
    })
  })
})

/**
 * The writer and the reader against each other, through the real channel.
 *
 * The unit tests above prove `parseAuditRecord` reads records it was handed;
 * only this proves it reads the lines a sink actually writes. The file sink
 * reuses `DailyFileChannel`, whose JSON format wraps a record in a log
 * envelope — so the two halves agreeing is a fact about that envelope, and
 * hand-written strings could never notice it changing.
 */
describe('the audit record through DailyFileChannel', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  test('should survive a round trip through the file sink', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guren-audit-'))
    dirs.push(dir)
    const basePath = join(dir, 'agent-audit.log')
    const channel = new DailyFileChannel({ driver: 'daily', path: basePath, format: 'json', level: 'debug' })

    const invoked = toAuditRecord(new AgentToolInvoked(PRINCIPAL, 'posts.index', { page: 2 }, 200, 17, 'mcp'), NOW)
    const denied = toAuditRecord(new AgentToolDenied(null, 'posts.store', { title: 'x' }, 'rate-limit', 'mcp'), NOW)
    for (const record of [invoked, denied]) {
      channel.log({ level: 'info', message: 'agent.audit', timestamp: new Date(record.ts), context: { ...record } })
    }

    const written = readFileSync(dailyFilePath(basePath, NOW), 'utf8')
    expect(written.split('\n').map(parseAuditRecord)).toEqual([invoked, denied, null])
  })
})

describe('DEFAULT_AGENT_AUDIT_PATH', () => {
  test('should sit under the storage/logs convention', () => {
    expect(DEFAULT_AGENT_AUDIT_PATH).toBe('storage/logs/agent-audit.log')
  })
})
