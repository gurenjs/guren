/**
 * A deep copy holding only JSON values, with `undefined` object keys dropped.
 * Anything else (a function, a Map, a class instance, a bigint) throws, so a
 * manifest field that would not survive `--json` fails here instead of vanishing.
 */
export function toPlainJson<T>(value: T, path = 'manifest'): T {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} is ${value}, which JSON cannot carry`)
    return value
  }
  if (Array.isArray(value)) return value.map((item, index) => toPlainJson(item, `${path}[${index}]`)) as T
  const proto = typeof value === 'object' ? Object.getPrototypeOf(value) : undefined
  if (proto === Object.prototype || proto === null) {
    const copy: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as object)) {
      if (item !== undefined) copy[key] = toPlainJson(item, `${path}.${key}`)
    }
    return copy as T
  }
  const kind = typeof value === 'object' ? (value as object).constructor?.name ?? 'object' : typeof value
  throw new TypeError(`${path} is a ${kind}, which JSON cannot carry`)
}
