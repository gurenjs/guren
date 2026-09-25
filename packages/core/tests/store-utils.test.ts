import { describe, expect, test } from 'bun:test'
import { bigint, integer as pgInteger, pgTable, text as pgText, timestamp } from 'drizzle-orm/pg-core'
import { datetime, mysqlTable, varchar } from 'drizzle-orm/mysql-core'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { isExpired, toColumnValue, toDate, toOptionalExpiry } from '../src/store-utils'

// Fixed "now" in the future: a past epoch would let a Date.now() regression
// pass an expiry test by accident.
const NOW = 4_000_000_000_000
const MINUTE = 60_000

describe('toDate', () => {
  test('accepts every representation a driver may return for a timestamp', () => {
    expect(toDate(new Date(NOW))).toEqual(new Date(NOW))
    expect(toDate(NOW)).toEqual(new Date(NOW))
    expect(toDate(BigInt(NOW))).toEqual(new Date(NOW))
    expect(toDate(String(NOW))).toEqual(new Date(NOW))
    expect(toDate(new Date(NOW).toISOString())).toEqual(new Date(NOW))
  })

  test('returns null for absent values', () => {
    expect(toDate(null)).toBeNull()
    expect(toDate(undefined)).toBeNull()
  })

  test('returns null for unparseable values, including Invalid Date instances', () => {
    // Drizzle's timestamp mappers wrap whatever the driver returned, so a
    // corrupt column arrives as an Invalid Date rather than as a raw string.
    expect(toDate(new Date('not-a-date'))).toBeNull()
    expect(toDate('not-a-date')).toBeNull()
    expect(toDate(Number.NaN)).toBeNull()
    expect(toDate(true)).toBeNull()
    expect(toDate({})).toBeNull()
    // Beyond the ECMAScript time-value range.
    expect(toDate(BigInt('9007199254740993000'))).toBeNull()
  })
})

describe('isExpired', () => {
  test('treats absent and unparseable values as expired', () => {
    expect(isExpired(null, NOW)).toBe(true)
    expect(isExpired(undefined, NOW)).toBe(true)
    expect(isExpired('not-a-date', NOW)).toBe(true)
    expect(isExpired(new Date('not-a-date'), NOW)).toBe(true)
  })

  test('compares parseable values against the supplied instant', () => {
    expect(isExpired(NOW + MINUTE, NOW)).toBe(false)
    expect(isExpired(NOW - MINUTE, NOW)).toBe(true)
    expect(isExpired(NOW, NOW)).toBe(true)
  })
})

describe('toOptionalExpiry', () => {
  test('keeps an absent expiry as null ("never expires")', () => {
    expect(toOptionalExpiry(null)).toBeNull()
    expect(toOptionalExpiry(undefined)).toBeNull()
  })

  test('passes parseable expiries through', () => {
    expect(toOptionalExpiry(NOW)).toEqual(new Date(NOW))
    expect(toOptionalExpiry(BigInt(NOW))).toEqual(new Date(NOW))
    expect(toOptionalExpiry(new Date(NOW).toISOString())).toEqual(new Date(NOW))
  })

  test('degrades a present-but-unparseable expiry to a past date, never to null', () => {
    for (const corrupt of [new Date('not-a-date'), 'not-a-date', true, {}]) {
      const expiry = toOptionalExpiry(corrupt)
      expect(expiry).not.toBeNull()
      expect(expiry!.getTime()).toBeLessThan(NOW)
    }
  })
})

describe('toColumnValue', () => {
  const at = new Date('2026-01-02T03:04:05.678Z')

  const sqlite = sqliteTable('sqlite_shapes', {
    iso: text('iso'),
    seconds: integer('seconds', { mode: 'timestamp' }),
    millis: integer('millis', { mode: 'timestamp_ms' }),
    epoch: integer('epoch'),
  })

  const pg = pgTable('pg_shapes', {
    stamp: timestamp('stamp', { withTimezone: true }),
    stampString: timestamp('stamp_string', { mode: 'string' }),
    iso: pgText('iso'),
    epoch: pgInteger('epoch'),
    big: bigint('big', { mode: 'bigint' }),
  })

  const mysql = mysqlTable('mysql_shapes', {
    stamp: datetime('stamp'),
    stampString: datetime('stamp_string', { mode: 'string' }),
    iso: varchar('iso', { length: 32 }),
  })

  test('passes a Date through to every timestamp-mode column', () => {
    expect(toColumnValue(sqlite, 'seconds', at)).toBe(at)
    expect(toColumnValue(sqlite, 'millis', at)).toBe(at)
    expect(toColumnValue(pg, 'stamp', at)).toBe(at)
    expect(toColumnValue(mysql, 'stamp', at)).toBe(at)
  })

  test('keeps a Date for a temporal column read in string mode, which the driver encodes itself', () => {
    expect(toColumnValue(pg, 'stampString', at)).toBe(at)
    expect(toColumnValue(mysql, 'stampString', at)).toBe(at)
  })

  test('writes the ISO string to a text column', () => {
    expect(toColumnValue(sqlite, 'iso', at)).toBe('2026-01-02T03:04:05.678Z')
    expect(toColumnValue(pg, 'iso', at)).toBe('2026-01-02T03:04:05.678Z')
    expect(toColumnValue(mysql, 'iso', at)).toBe('2026-01-02T03:04:05.678Z')
  })

  test('writes epoch milliseconds to an integer column with no mode, as toDate reads it back', () => {
    expect(toColumnValue(sqlite, 'epoch', at)).toBe(at.getTime())
    expect(toColumnValue(pg, 'epoch', at)).toBe(at.getTime())
    expect(toColumnValue(pg, 'big', at)).toBe(BigInt(at.getTime()))
    expect(toDate(toColumnValue(sqlite, 'epoch', at))).toEqual(at)
  })

  test('leaves anything but a Date alone', () => {
    expect(toColumnValue(sqlite, 'iso', null)).toBeNull()
    expect(toColumnValue(sqlite, 'iso', 'already-a-string')).toBe('already-a-string')
    expect(toColumnValue(sqlite, 'epoch', 12)).toBe(12)
  })

  test('passes a Date through for a column the table does not declare', () => {
    expect(toColumnValue(sqlite, 'missing', at)).toBe(at)
    expect(toColumnValue(undefined, 'iso', at)).toBe(at)
  })
})
