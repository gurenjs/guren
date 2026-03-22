import type { PlainObject } from './Model'

/** Accessor function: transforms a record field value after reading from DB. */
export type AccessorFn<T = unknown> = (record: PlainObject) => T

/** Mutator function: transforms a field value before writing to DB. */
export type MutatorFn<T = unknown> = (value: T, record: PlainObject) => unknown

/** Map of field names to accessor functions. */
export type AccessorDefinitions = Record<string, AccessorFn>

/** Map of field names to mutator functions. */
export type MutatorDefinitions = Record<string, MutatorFn>

/** Apply accessors to a record, returning a new record with computed values. */
export function applyAccessors<T extends PlainObject>(record: T, accessors?: AccessorDefinitions): T {
  if (!accessors) return record
  const keys = Object.keys(accessors)
  if (keys.length === 0) return record

  const result = { ...record }
  for (const key of keys) {
    result[key as keyof T] = accessors[key](result) as T[keyof T]
  }
  return result
}

/** Apply mutators to data before persistence, returning a new object. */
export function applyMutators(data: PlainObject, mutators?: MutatorDefinitions): PlainObject {
  if (!mutators) return data
  const keys = Object.keys(mutators)
  if (keys.length === 0) return data

  const result = { ...data }
  for (const key of keys) {
    if (key in result) {
      result[key] = mutators[key](result[key], result)
    }
  }
  return result
}
