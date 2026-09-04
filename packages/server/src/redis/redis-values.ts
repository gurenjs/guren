/**
 * Decoding rules shared by the Redis-backed stores. Expiry coercion lives in
 * `../support/expiry`, so there is one rule rather than one per store.
 */

/**
 * Corrupt text degrades to no abilities (deny-by-default) rather than throwing
 * on every verification of the affected token. Anything that decodes to a
 * non-list degrades the same way: `tokenCan` would otherwise run
 * `String.prototype.includes` on it, so a stored `'"*"'` would grant everything.
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
