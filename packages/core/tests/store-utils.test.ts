import { describe, expect, test } from 'bun:test'
import { isExpired, toDate, toOptionalExpiry } from '../src/store-utils'

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
