/**
 * Expiry coercion and the one predicate that decides whether a stored expiry
 * has passed.
 *
 * These mirror `toDate`/`isExpired`/`toOptionalExpiry` in
 * `packages/core/src/store-utils.ts` — deliberately, not accidentally.
 * `@guren/core` depends on `@guren/server` and not the other way around, so
 * core is unreachable from here without a dependency cycle. Keep the two in
 * step until the shared copy moves under this package and core re-exports it.
 */

/**
 * Coerce a stored timestamp, rejecting anything unparseable.
 *
 * Accepts every shape a driver or a Redis value can hand back: Date, number,
 * bigint (MySQL / postgres.js BIGINT), digit-only strings as epoch
 * milliseconds, and ISO strings. A Date wrapping garbage is a parse failure,
 * not a value — `new Date(garbage)` yields an Invalid Date whose comparisons
 * are all false, which is exactly how a corrupt expiry reads as "not past".
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
 * Whether an expiry that is required to be present has passed.
 *
 * Missing or unparseable counts as expired, so a malformed record can never be
 * accepted indefinitely. Use for sessions and OAuth state, whose writers always
 * supply an expiry.
 */
export function isExpired(value: unknown, now: number = Date.now()): boolean {
  const date = toDate(value)
  return date === null || date.getTime() <= now
}

/**
 * Whether an expiry that is allowed to be absent has passed.
 *
 * Absent means "never expires" and is never past. Present-but-unparseable is a
 * malformed record and counts as expired — collapsing the two is the fail-open
 * this exists to close. Use at the point of comparison, so the check holds for
 * every store implementation including ones this package never sees.
 */
export function isOptionalExpiryPast(value: unknown, now: number = Date.now()): boolean {
  if (value == null) return false
  return isExpired(value, now)
}

/**
 * Coerce an expiry that is allowed to be absent into a value callers can
 * compare directly: absent stays null, present-but-unparseable degrades to a
 * long-past date rather than to null, which would read as "never expires".
 */
export function toOptionalExpiry(value: unknown): Date | null {
  if (value == null) return null
  return toDate(value) ?? new Date(0)
}
