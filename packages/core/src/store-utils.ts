/**
 * Shared coercion for database-backed stores (api tokens, sessions, OAuth
 * state). Drizzle returns Date for timestamp-mode columns, but plain columns
 * yield numbers, numeric strings (postgres.js bigint), or ISO strings —
 * reads must accept all of them. Unparseable values return null.
 */
export function toDate(value: unknown): Date | null {
  if (value == null) return null
  if (value instanceof Date) return value
  if (typeof value === 'number') return new Date(value)
  if (typeof value === 'string') {
    const date = new Date(/^\d+$/.test(value) ? Number(value) : value)
    return Number.isNaN(date.getTime()) ? null : date
  }
  return null
}

/**
 * Fail-closed expiry check for columns that must always carry an expiry:
 * a missing or unparseable value counts as expired, so a malformed row can
 * never be accepted indefinitely.
 */
export function isExpired(value: unknown, now: number = Date.now()): boolean {
  const date = toDate(value)
  if (date === null) return true
  const time = date.getTime()
  // Invalid Date instances (drizzle timestamp modes wrap garbage in Date)
  // must also fail closed.
  return Number.isNaN(time) || time <= now
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
