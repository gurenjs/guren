/**
 * A deep copy holding only JSON values, with `undefined` object keys dropped and
 * `undefined` array items turned into `null`, as `JSON.stringify` does. Anything
 * else (a function, a Map, a class instance, a bigint, a cycle) throws, so a
 * manifest field that would not survive `--json` fails here instead of vanishing.
 */
export function toPlainJson<T>(value: T): T {
  return copy(value, 'manifest', new Set()) as T
}

function refuse(path: string, what: string): never {
  throw new TypeError(`${path} (${what}) cannot be carried by JSON`)
}

function copy(value: unknown, path: string, ancestors: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : refuse(path, String(value))
  if (typeof value !== 'object') return refuse(path, typeof value)
  if (ancestors.has(value)) refuse(path, 'a reference to its own ancestor')

  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => (item === undefined ? null : copy(item, `${path}[${index}]`, ancestors)))
    }
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) refuse(path, (value as object).constructor?.name ?? 'object')
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) result[key] = copy(item, `${path}.${key}`, ancestors)
    }
    return result
  } finally {
    ancestors.delete(value)
  }
}
