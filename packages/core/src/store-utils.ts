/**
 * Expiry coercion for the database-backed stores. Drizzle returns Date for
 * timestamp-mode columns, but plain columns yield numbers, bigints (MySQL /
 * postgres.js BIGINT), numeric strings, or ISO strings — reads accept all.
 *
 * The rules live in `@guren/server` so the Redis-backed stores share them
 * (core depends on server, never the reverse). Deliberately not re-exported
 * from this package's index, which would make them public API.
 */
export { isExpired, toDate, toOptionalExpiry } from '@guren/server/support/expiry'

/**
 * Decode a JSON-capable column holding either the native value (drizzle json
 * mode) or a text-encoded string. Corrupt text falls back instead of throwing,
 * so one bad row cannot break every read.
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
