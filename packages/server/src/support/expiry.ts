/**
 * The single copy of expiry coercion: `packages/core/src/store-utils.ts`
 * re-exports these through the `@guren/server/support/expiry` subpath, so the
 * database-backed and Redis stores decide expiry with the same code. It lives
 * here because core depends on server and not the reverse. Not public API —
 * neither package's index exposes it.
 */

/**
 * Accepts every shape a driver or Redis value hands back: Date, number, bigint
 * (MySQL / postgres.js BIGINT), digit-only strings as epoch milliseconds, ISO
 * strings. An Invalid Date is a parse failure, not a value: its comparisons are
 * all false, which is exactly how a corrupt expiry reads as "not past".
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
 * For an expiry required to be present (sessions, OAuth state). Missing or
 * unparseable counts as expired, so a malformed record is never accepted
 * indefinitely.
 */
export function isExpired(value: unknown, now: number = Date.now()): boolean {
  const date = toDate(value)
  return date === null || date.getTime() <= now
}

/**
 * Absent means "never expires"; present-but-unparseable counts as expired.
 * Collapsing the two is the fail-open this exists to close. Call it at the
 * point of comparison so the rule holds for stores this package never sees.
 */
export function isOptionalExpiryPast(value: unknown, now: number = Date.now()): boolean {
  if (value == null) return false
  return isExpired(value, now)
}

/**
 * Absent stays null; present-but-unparseable degrades to a long-past date
 * rather than null, which would read as "never expires".
 */
export function toOptionalExpiry(value: unknown): Date | null {
  if (value == null) return null
  return toDate(value) ?? new Date(0)
}
