import { Database } from 'bun:sqlite'
import { describe, test, expect, beforeEach } from 'bun:test'

import { firesSooner, PendingCallLedger, type LedgerCipher, type LedgerSql } from './ledger'

/**
 * The ledger against real SQLite (RFC 0017 §5).
 *
 * `bun:sqlite` rather than a fake store: a stand-in accepting any SQL would let
 * a statement workerd rejects pass here. The cipher is reversible and obvious,
 * so encryption at rest is asserted on the raw column rather than trusted.
 */

/** `Agent.sql`'s shape over `bun:sqlite`: synchronous, tagged, rows out. */
function sqlOver(db: Database): LedgerSql {
  return (strings, ...values) => {
    const statement = strings.join('?')
    const params = values as Array<string | number | null>
    return db.query(statement).all(...params) as Array<Record<string, never>>
  }
}

/** Reversible and inspectable: a test asserts the raw column is not plaintext. */
const cipher: LedgerCipher = {
  encrypt: (text) => `sealed:${Buffer.from(text, 'utf8').toString('base64')}`,
  decrypt: (text) => Buffer.from(text.slice('sealed:'.length), 'base64').toString('utf8'),
}

const NOW = new Date('2026-09-05T12:00:00.000Z')

function at(offsetMs: number): string {
  return new Date(NOW.getTime() + offsetMs).toISOString()
}

let db: Database
let ledger: PendingCallLedger

beforeEach(() => {
  db = new Database(':memory:')
  ledger = new PendingCallLedger(sqlOver(db), cipher)
})

function park(requestId: string, overrides: Partial<Parameters<PendingCallLedger['record']>[0]> = {}): void {
  ledger.record({
    requestId,
    tool: 'posts.destroy',
    args: { id: 7 },
    requestedAt: NOW.toISOString(),
    expiresAt: at(60 * 60 * 1000),
    ...overrides,
  })
}

describe('PendingCallLedger: rows', () => {
  test('should create its table on first use', () => {
    expect(ledger.all()).toEqual([])
  })

  test('should round-trip a parked call with its arguments', () => {
    park('req-1', { args: { id: 7, reason: 'stale' } })

    expect(ledger.all()).toEqual([
      {
        requestId: 'req-1',
        tool: 'posts.destroy',
        args: { id: 7, reason: 'stale' },
        requestedAt: NOW.toISOString(),
        expiresAt: at(60 * 60 * 1000),
        checks: 0,
      },
    ])
  })

  test('should store the arguments encrypted at rest', () => {
    park('req-1', { args: { secret: 'hunter2-distinctive' } })

    const [row] = db.query('SELECT args FROM guren_pending_tool_calls').all() as Array<{ args: string }>
    expect(row!.args).not.toContain('hunter2-distinctive')
    expect(row!.args).not.toContain('secret')
    // Reversible for the retry — the point is the column, not a one-way hash.
    expect(JSON.parse(cipher.decrypt(row!.args))).toEqual({ secret: 'hunter2-distinctive' })
  })

  test('should replace a row recorded twice under one request id', () => {
    park('req-1', { args: { id: 1 } })
    park('req-1', { args: { id: 2 } })

    expect(ledger.all()).toHaveLength(1)
    expect(ledger.all()[0]!.args).toEqual({ id: 2 })
  })

  test('should remove a row by request id', () => {
    park('req-1')
    park('req-2')

    ledger.remove('req-1')

    expect(ledger.all().map((call) => call.requestId)).toEqual(['req-2'])
  })

  test('should count checks per row', () => {
    park('req-1')
    ledger.bumpChecks('req-1')
    ledger.bumpChecks('req-1')

    expect(ledger.all()[0]!.checks).toBe(2)
  })
})

describe('PendingCallLedger: pruning', () => {
  test('should drop and report rows past their expiry', () => {
    park('gone', { expiresAt: at(-1) })
    park('alive', { expiresAt: at(60_000) })

    const pruned = ledger.pruneExpired(NOW)

    expect(pruned.map((call) => call.requestId)).toEqual(['gone'])
    expect(ledger.all().map((call) => call.requestId)).toEqual(['alive'])
  })

  test('should drop a row whose expiry cannot be read', () => {
    // The direction `agentApprovalExpiredAt` fails in: a date the framework
    // cannot parse is expired, never "not expired yet".
    park('unreadable', { expiresAt: 'not a date' })

    expect(ledger.pruneExpired(NOW).map((call) => call.requestId)).toEqual(['unreadable'])
    expect(ledger.all()).toEqual([])
  })

  test('should keep a row expiring exactly at now out of the future', () => {
    park('boundary', { expiresAt: NOW.toISOString() })

    expect(ledger.pruneExpired(NOW)).toHaveLength(1)
  })
})

describe('PendingCallLedger: the next wake', () => {
  test('should answer nothing when no row is waiting', () => {
    expect(ledger.nextDelaySeconds(NOW)).toBeUndefined()
  })

  test('should start at 30 seconds and double per check', () => {
    park('req-1')
    expect(ledger.nextDelaySeconds(NOW)).toBe(30)

    ledger.bumpChecks('req-1')
    expect(ledger.nextDelaySeconds(NOW)).toBe(60)

    ledger.bumpChecks('req-1')
    expect(ledger.nextDelaySeconds(NOW)).toBe(120)
  })

  test('should follow the least-checked row, not the most', () => {
    // One wake asks about every row, so the cadence serves the newest parked
    // call rather than inheriting the oldest row's stretched backoff.
    park('old')
    for (let check = 0; check < 5; check++) ledger.bumpChecks('old')
    park('new')

    expect(ledger.nextDelaySeconds(NOW)).toBe(30)
  })

  test('should cap the wake at the earliest expiry plus a grace', () => {
    park('soon', { expiresAt: at(10_000) })

    // 30s of backoff would land past the request's life, and the row would
    // never be reported as expired.
    expect(ledger.nextDelaySeconds(NOW)).toBe(15)
  })

  test('should cap the backoff at the approval TTL', () => {
    park('req-1', { expiresAt: at(10 * 60 * 60 * 1000) })
    for (let check = 0; check < 12; check++) ledger.bumpChecks('req-1')

    expect(ledger.nextDelaySeconds(NOW)).toBe(3600)
  })

  test('should never answer a delay a schedule cannot honour', () => {
    // A row can cross its expiry between the prune and this call.
    park('lapsed', { expiresAt: at(-60_000) })

    expect(ledger.nextDelaySeconds(NOW)).toBe(1)
  })
})

describe('PendingCallLedger: rows no key can open', () => {
  /** One row's ciphertext is rejected, as a rotated app key would reject it. */
  function ledgerRefusing(marker: string): PendingCallLedger {
    return new PendingCallLedger(sqlOver(db), {
      encrypt: cipher.encrypt,
      decrypt: (text) => {
        const opened = cipher.decrypt(text)
        if (opened.includes(marker)) throw new Error('no key opens this row')
        return opened
      },
    })
  }

  test('should skip an unreadable row rather than throw', () => {
    park('readable', { args: { id: 1 } })
    park('rotated', { args: { id: 'ROTATED' } })

    // `all()` backs the record path too, so a throw here would deny a caller the
    // `pending` result of a call that was parked perfectly well.
    const rows = ledgerRefusing('ROTATED').all()

    expect(rows.map((call) => call.requestId)).toEqual(['readable'])
  })

  test('should drop and report unreadable rows', () => {
    park('readable', { args: { id: 1 } })
    park('rotated', { args: { id: 'ROTATED' } })
    const ledgerWithRotation = ledgerRefusing('ROTATED')

    const unreadable = ledgerWithRotation.pruneUnreadable()

    expect(unreadable).toEqual([{ requestId: 'rotated', tool: 'posts.destroy' }])
    expect(ledgerWithRotation.all().map((call) => call.requestId)).toEqual(['readable'])
    // Gone from the table, not merely filtered out of the read.
    expect(db.query('SELECT request_id FROM guren_pending_tool_calls').all()).toEqual([
      { request_id: 'readable' },
    ])
  })

  test('should still answer a delay when one row is unreadable', () => {
    park('rotated', { args: { id: 'ROTATED' } })
    park('readable', { args: { id: 1 } })

    expect(ledgerRefusing('ROTATED').nextDelaySeconds(NOW)).toBe(30)
  })
})

describe('firesSooner', () => {
  /** `Schedule.time` is Unix seconds for every schedule type. */
  const nowSeconds = Math.floor(NOW.getTime() / 1000)

  test('should schedule when nothing is pending', () => {
    expect(firesSooner(30, NOW, [])).toBe(true)
  })

  test('should replace a check that fires after the one this row needs', () => {
    // A row expiring in five minutes, against a check twenty minutes out.
    expect(firesSooner(300, NOW, [nowSeconds + 1200])).toBe(true)
  })

  test('should keep a check that already fires sooner', () => {
    expect(firesSooner(300, NOW, [nowSeconds + 60])).toBe(false)
  })

  test('should keep a check equal to the one it would create', () => {
    expect(firesSooner(300, NOW, [nowSeconds + 300])).toBe(false)
  })

  test('should compare against the earliest of several', () => {
    expect(firesSooner(300, NOW, [nowSeconds + 1200, nowSeconds + 60])).toBe(false)
  })

  test('should schedule past a time it cannot read', () => {
    // The opposite would let one unreadable row suppress every later check.
    expect(firesSooner(300, NOW, [Number.NaN])).toBe(true)
  })
})
