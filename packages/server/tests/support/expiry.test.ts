import { describe, expect, test } from 'bun:test'
import { isExpired, isOptionalExpiryPast, toDate, toOptionalExpiry } from '../../src/support/expiry'

// Fixed "now" in the future: a past epoch would let a Date.now() regression
// pass an expiry test by accident.
const NOW = 4_000_000_000_000
const MINUTE = 60_000

// Mirrors packages/core/tests/store-utils.test.ts — the two modules are
// deliberately kept in step (see the block comment atop expiry.ts) — so this
// suite stays structurally comparable rather than accidentally drifting.

describe('toDate', () => {
  test('accepts every representation a driver or Redis value may return for a timestamp', () => {
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
    // A Date wrapping garbage is a parse failure, not a value — this is what a
    // corrupt timestamp mapper or a corrupt Redis JSON payload hands back.
    expect(toDate(new Date('not-a-date'))).toBeNull()
    expect(toDate('not-a-date')).toBeNull()
    expect(toDate('')).toBeNull()
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

describe('isOptionalExpiryPast', () => {
  test('treats an absent expiry as "never expires", not as past', () => {
    expect(isOptionalExpiryPast(null, NOW)).toBe(false)
    expect(isOptionalExpiryPast(undefined, NOW)).toBe(false)
  })

  test('treats a present-but-unparseable expiry as past — the fail-open this closes', () => {
    // Collapsing "absent" and "unparseable" to the same outcome is exactly the
    // bug: a malformed record must not read the same as "no expiry at all".
    expect(isOptionalExpiryPast('not-a-date', NOW)).toBe(true)
    expect(isOptionalExpiryPast(new Date('not-a-date'), NOW)).toBe(true)
  })

  test('compares a present parseable expiry against the supplied instant', () => {
    expect(isOptionalExpiryPast(NOW + MINUTE, NOW)).toBe(false)
    expect(isOptionalExpiryPast(NOW - MINUTE, NOW)).toBe(true)
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
    // Degrading to null would read as "never expires" — the same fail-open
    // isOptionalExpiryPast exists to close, just on the coercion side.
    for (const corrupt of [new Date('not-a-date'), 'not-a-date', true, {}]) {
      const expiry = toOptionalExpiry(corrupt)
      expect(expiry).not.toBeNull()
      expect(expiry!.getTime()).toBeLessThan(NOW)
    }
  })
})
