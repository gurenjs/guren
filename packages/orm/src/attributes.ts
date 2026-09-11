import type { PlainObject } from './Model'

/** Accessor function: transforms a record field value after reading from DB. */
export type AccessorFn<T = unknown> = (record: PlainObject) => T

/** Mutator function: transforms a field value before writing to DB. */
export type MutatorFn<T = unknown> = (value: T, record: PlainObject) => unknown

export type AccessorDefinitions = Record<string, AccessorFn>

export type MutatorDefinitions = Record<string, MutatorFn>

const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * A computed field is written with `record[key] = …`, and `__proto__` as a key
 * would rewrite the record's prototype rather than a column. The names come
 * from a model's static definitions, so refusing them is a boot-time mistake
 * surfacing at first use, not a runtime input check.
 */
function assertWritableKey(key: string, kind: 'accessor' | 'mutator'): void {
  if (PROTOTYPE_KEYS.has(key)) {
    throw new Error(`An ${kind} cannot be named "${key}": that key would alter the record's prototype.`)
  }
}

/** Writes the computed values onto `record`; each accessor sees the ones before it. */
export function applyAccessorsInPlace(record: PlainObject, accessors: AccessorDefinitions): void {
  for (const key of Object.keys(accessors)) {
    assertWritableKey(key, 'accessor')
    record[key] = accessors[key](record)
  }
}

/** Apply accessors to a record, returning a new record with computed values. */
export function applyAccessors<T extends PlainObject>(record: T, accessors?: AccessorDefinitions): T {
  if (!accessors) return record
  if (Object.keys(accessors).length === 0) return record

  const result = { ...record }
  applyAccessorsInPlace(result, accessors)
  return result
}

/** Apply mutators to data before persistence, returning a new object. */
export function applyMutators(data: PlainObject, mutators?: MutatorDefinitions): PlainObject {
  if (!mutators) return data
  const keys = Object.keys(mutators)
  if (keys.length === 0) return data

  const result = { ...data }
  for (const key of keys) {
    assertWritableKey(key, 'mutator')
    if (Object.hasOwn(result, key)) {
      result[key] = mutators[key](result[key], result)
    }
  }
  return result
}
