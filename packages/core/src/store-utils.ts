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

/** Drizzle's public column facts: the same `dataType` the ORM's `columnKind()` reads, plus the declared SQL type. */
interface ColumnShape {
  dataType?: unknown
  getSQLType?: () => string
}

/** `timestamp with time zone`, `timestamp(3)`, `datetime`, `date`, `time`: every driver binds a Date to these itself. */
const TEMPORAL_SQL_TYPE = /^(?:timestamp|datetime|date|time)\b/i

/**
 * A Date as the column declares it: temporal columns take the Date (drizzle and
 * the pg/mysql drivers encode it), text takes the ISO string the SQLite scaffold's
 * `$defaultFn` writes, integer takes epoch ms (`timestamp_ms`, what `toDate` reads).
 * bun:sqlite cannot bind a Date, and a where clause binding one matches no row.
 * `dataType` is split the way the ORM's `columnKind()` splits it (1.x: `number int53`).
 */
export function toColumnValue<T>(table: unknown, field: string, value: T): T | string | number | bigint {
  if (!(value instanceof Date)) return value
  const column = (table as Record<string, ColumnShape | undefined> | null)?.[field]
  if (!column || typeof column !== 'object') return value
  const sqlType = typeof column.getSQLType === 'function' ? column.getSQLType() : ''
  if (TEMPORAL_SQL_TYPE.test(sqlType)) return value
  const kind = typeof column.dataType === 'string' ? column.dataType.split(' ')[0] : ''
  if (kind === 'string') return value.toISOString()
  if (kind === 'number') return value.getTime()
  if (kind === 'bigint') return BigInt(value.getTime())
  return value
}
