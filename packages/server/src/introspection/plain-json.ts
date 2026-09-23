/**
 * A deep copy holding only JSON values, with `undefined` object keys dropped.
 * Anything else (a function, a Map, a class instance, a bigint) throws, so a
 * manifest field that would not survive `--json` fails here instead of vanishing.
 */
export function toPlainJson<T>(value: T): T {
  return copy(value, 'manifest') as T
}

function copy(value: unknown, path: string): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} is ${value}, which JSON cannot carry`)
    return value
  }
  if (Array.isArray(value)) return value.map((item, index) => copy(item, `${path}[${index}]`))
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value)
    if (proto === Object.prototype || proto === null) {
      const result: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value)) {
        if (item !== undefined) result[key] = copy(item, `${path}.${key}`)
      }
      return result
    }
    throw new TypeError(`${path} is a ${(value as object).constructor?.name ?? 'object'}, which JSON cannot carry`)
  }
  throw new TypeError(`${path} is a ${typeof value}, which JSON cannot carry`)
}
