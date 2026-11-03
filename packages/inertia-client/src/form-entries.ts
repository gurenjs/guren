// Shared by the prototype runtime and the MCP App bridge, which read visit data alike.
/** A `FormData` body as a plain object; a repeated key or a `name[]` key becomes an array. */
export function formDataToObject(data: FormData): Record<string, unknown> {
  return collectEntries(data.entries())
}

/**
 * Entries keyed by user-supplied names, gathered in a Map and materialized
 * with `Object.fromEntries`, which defines own properties: a `__proto__` key
 * lands as data instead of reaching the prototype setter.
 */
export function collectEntries(entries: Iterable<[string, unknown]>): Record<string, unknown> {
  const collected = new Map<string, unknown>()
  for (const [rawKey, value] of entries) {
    const forceArray = rawKey.endsWith('[]')
    const key = forceArray ? rawKey.slice(0, -2) : rawKey
    const existing = collected.get(key)
    if (existing === undefined) {
      collected.set(key, forceArray ? [value] : value)
    } else if (Array.isArray(existing)) {
      existing.push(value)
    } else {
      collected.set(key, [existing, value])
    }
  }
  return Object.fromEntries(collected)
}
