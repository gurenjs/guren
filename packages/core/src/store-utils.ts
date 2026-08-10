/**
 * Coercion for the database-backed stores (api tokens, sessions, OAuth
 * state). Drizzle returns Date for timestamp-mode columns, but plain columns
 * yield numbers, bigints (MySQL / postgres.js BIGINT), numeric strings, or
 * ISO strings — reads must accept all of them.
 *
 * The expiry rules live in `@guren/server` rather than here, because the
 * Redis-backed stores ship there and cannot import from `@guren/core`
 * without a dependency cycle (core depends on server, never the reverse).
 * Re-exporting keeps one implementation for both backends: a fix to a
 * boundary case can no longer land in one and silently miss its sibling.
 *
 * Not exported from this package's index: `index.ts` opens with
 * `export * from '@guren/server'`, so anything re-exported there becomes
 * public `@guren/core` API.
 */
export { isExpired, toDate, toOptionalExpiry } from '@guren/server/support/expiry'

/**
 * Decode a JSON-capable column that may hold either the native value
 * (drizzle json mode) or a text-encoded string. Corrupt text falls back
 * instead of throwing, so one bad row cannot break every read.
 *
 * Stays here: it is a drizzle column concern, and the Redis stores decode
 * their own JSON payloads through `redis-values.ts` instead.
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
