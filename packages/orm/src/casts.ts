import type { CastType, PlainObject } from './Model'

export function castInPlace(target: PlainObject, castDefs: Record<string, CastType>): void {
  for (const [field, castType] of Object.entries(castDefs)) {
    if (!(field in target)) continue
    const value = target[field]
    if (value == null) continue

    switch (castType) {
      case 'json': {
        if (typeof value === 'string') {
          try {
            target[field] = JSON.parse(value)
          } catch {
          }
        }
        break
      }
      case 'date': {
        if (!(value instanceof Date)) {
          target[field] = new Date(value as string | number)
        }
        break
      }
      case 'boolean': {
        target[field] = Boolean(value)
        break
      }
      case 'number': {
        target[field] = Number(value)
        break
      }
      case 'string': {
        target[field] = String(value)
        break
      }
    }
  }
}
