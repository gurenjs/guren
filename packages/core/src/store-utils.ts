/**
 * Shared coercion for database-backed stores (api tokens, sessions, OAuth
 * state). Drizzle returns Date for timestamp-mode columns but raw numbers or
 * strings for plain columns; reads must accept all three.
 */
export function toDate(value: unknown): Date | null {
  if (value == null) return null
  if (value instanceof Date) return value
  if (typeof value === 'string' || typeof value === 'number') return new Date(value)
  return null
}
