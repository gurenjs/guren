/**
 * Shared coercion for database-backed stores (api tokens, sessions, OAuth
 * state). Drizzle returns Date for timestamp-mode columns, but plain columns
 * yield numbers, bigints (MySQL / postgres.js BIGINT), numeric strings, or
 * ISO strings — reads must accept all of them.
 *
 * Unparseable values return null, and that includes Date instances wrapping
 * garbage: drizzle's timestamp mappers hand whatever the driver returned to
 * `new Date(...)`, so a corrupt column reaches callers as an Invalid Date
 * rather than as a parse failure. Normalizing it here is what lets callers
 * express their expiry policy with a single null check.
 */
export function toDate(value: unknown): Date | null {
  const date = coerceDate(value)
  return date !== null && !Number.isNaN(date.getTime()) ? date : null
}

function coerceDate(value: unknown): Date | null {
  if (value == null) return null
  if (value instanceof Date) return value
  if (typeof value === 'number' || typeof value === 'bigint') return new Date(Number(value))
  if (typeof value === 'string') return new Date(/^\d+$/.test(value) ? Number(value) : value)
  return null
}

/**
 * Fail-closed expiry check for columns that must always carry an expiry
 * (sessions, OAuth state): a missing or unparseable value counts as expired,
 * so a malformed row can never be accepted indefinitely.
 */
export function isExpired(value: unknown, now: number = Date.now()): boolean {
  const date = toDate(value)
  return date === null || date.getTime() <= now
}

/**
 * Fail-closed expiry coercion for columns where NULL legitimately means
 * "never expires" — API tokens, whose `expiresAt` is nullable by design.
 *
 * An absent value and an unparseable one are not the same thing: the first is
 * a token created without an expiry, the second is a malformed row. Collapsing
 * both to null would make a corrupt row read as immortal, so anything present
 * but unparseable degrades to a long-past date and reads as expired.
 */
export function toOptionalExpiry(value: unknown): Date | null {
  if (value == null) return null
  return toDate(value) ?? new Date(0)
}

/**
 * Decode a JSON-capable column that may hold either the native value
 * (drizzle json mode) or a text-encoded string. Corrupt text falls back
 * instead of throwing, so one bad row cannot break every read.
 */
export function decodeJsonColumn<T>(value: unknown, fallback: T): T {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T
    } catch {
      return fallback
    }
  }
  return (value ?? fallback) as T
}
