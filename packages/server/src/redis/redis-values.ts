/**
 * Decoding rules shared by the Redis-backed stores.
 *
 * Expiry coercion lives in `../support/expiry` — every store reads its expiry
 * through `toDate`/`toOptionalExpiry`/`isExpired` there, so there is one rule
 * rather than one per store.
 */

/**
 * Decode a JSON-encoded ability list.
 *
 * Corrupt text degrades to no abilities (deny-by-default) instead of throwing
 * on every verification of the affected token. A value that decodes to
 * something other than a list of strings degrades the same way: `tokenCan`
 * would otherwise run `String.prototype.includes` on it, so a stored `'"*"'`
 * would grant every ability.
 */
export function decodeAbilities(value: unknown): string[] {
  if (value == null || value === '') return []
  let parsed: unknown = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value)
    } catch {
      return []
    }
  }
  return Array.isArray(parsed)
    ? parsed.filter((ability): ability is string => typeof ability === 'string')
    : []
}
