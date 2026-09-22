import { applyAccessorsInPlace } from './attributes'
import { castInPlace } from './casts'
import { DEFAULT_IN_LIST_SIZE, RAW_RESULTS } from './internal-keys'
import { Model, type ModelQueryOptions, type ORMAdapter, type PlainObject, type WhereClause } from './Model'
import type { EagerLoadConstraint, ORMAdapterAdvanced } from './QueryBuilder'
import type { RelationDefinition } from './relation-definitions'

/**
 * Written onto the records rather than onto copies: the parent rows hold them
 * by reference, and a nested loader has already keyed its own rows on them.
 * Keep in step with `[READ_TRANSFORMS]`: same casts-then-accessors order, and
 * the same rule that `projected` rows (a constraint's `select()` narrowed them)
 * skip the accessors, which would read a column that is not on them.
 */
export function applyRelatedReadTransforms(related: typeof Model, records: PlainObject[], projected: boolean): void {
  const casts = related.casts
  const accessors = projected ? undefined : related.accessors
  if (!casts && !accessors) return

  for (const record of records) {
    if (casts) castInPlace(record, casts)
    if (accessors) applyAccessorsInPlace(record, accessors)
  }
}

export async function loadRelationData(
  records: PlainObject[],
  name: string,
  related: typeof Model,
  parentKey: string,
  relatedKey: string,
  isArray: boolean,
  queryOptions?: ModelQueryOptions,
  constraint?: EagerLoadConstraint,
): Promise<boolean> {
  const values = distinctKeys(records, parentKey)

  if (values.length === 0) {
    for (const record of records) {
      record[name] = isArray ? [] : null
    }
    return false
  }

  const { records: relatedRecords, projected } = await loadRelatedRecords(
    related,
    values,
    (chunk) => ({ [relatedKey]: chunk }),
    queryOptions,
    constraint,
  )
  const map = new Map<unknown, PlainObject | PlainObject[]>()

  for (const item of relatedRecords) {
    const key = item[relatedKey]
    if (isArray) {
      if (!map.has(key)) map.set(key, [])
      ;(map.get(key) as PlainObject[]).push({ ...item })
    } else {
      map.set(key, { ...item })
    }
  }

  for (const record of records) {
    const key = record[parentKey]
    if (key == null) {
      record[name] = isArray ? [] : null
      continue
    }
    record[name] = map.get(key) ?? (isArray ? [] : null)
  }

  return projected
}

export function maxInListSize(adapter: ORMAdapter): number {
  const size = (adapter as ORMAdapterAdvanced).maxInListSize?.()
  return typeof size === 'number' && size >= 1 ? Math.floor(size) : DEFAULT_IN_LIST_SIZE
}

interface RelationCountPlan {
  related: Parameters<typeof resolveModelReference>[0]
  parentKey: string
  childKey: string
  where: Record<string, unknown>
  /** belongsTo yields 0 or 1, so the owner row only has to be shown to exist. */
  presenceOnly: boolean
}

export function relationCountPlan(definition: RelationDefinition, parentType: string): RelationCountPlan | undefined {
  switch (definition.type) {
    case 'hasMany':
    case 'hasOne':
      return {
        related: definition.related,
        parentKey: definition.localKey,
        childKey: definition.foreignKey,
        where: {},
        presenceOnly: false,
      }
    case 'morphMany':
      return {
        related: definition.related,
        parentKey: definition.localKey,
        childKey: `${definition.morphName}Id`,
        where: { [`${definition.morphName}Type`]: parentType },
        presenceOnly: false,
      }
    case 'belongsTo':
      return {
        related: definition.related,
        parentKey: definition.foreignKey,
        childKey: definition.ownerKey,
        where: {},
        presenceOnly: true,
      }
    default:
      return undefined
  }
}

/**
 * One row per owner key that exists, never a grouped COUNT: the answer is 0 or
 * 1, and the key column alone is all of the owner row anything here reads.
 */
export async function countOwnersPresent(
  related: typeof Model,
  ownerKey: string,
  keys: readonly unknown[],
  size: number,
  queryOptions?: ModelQueryOptions,
): Promise<Map<unknown, number>> {
  const rows = await loadByChunks(keys, size, (chunk) => related
    .newQuery(queryOptions)
    .where({ [ownerKey]: chunk } as WhereClause)
    .select(ownerKey)[RAW_RESULTS]() as Promise<PlainObject[]>)
  return new Map(rows.map((row) => [row[ownerKey], 1]))
}

export function distinctKeys(records: readonly PlainObject[], key: string): unknown[] {
  return Array.from(new Set(records.map((r) => r[key]).filter((v) => v != null)))
}

function chunkKeys(values: readonly unknown[], size: number): Array<readonly unknown[]> {
  if (values.length <= size) return [values]
  const chunks: unknown[][] = []
  for (let i = 0; i < values.length; i += size) {
    chunks.push(values.slice(i, i + size))
  }
  return chunks
}

export async function loadByChunks<T>(
  values: readonly unknown[],
  size: number,
  load: (chunk: readonly unknown[]) => Promise<T[]>,
): Promise<T[]> {
  const results: T[] = []
  for (const chunk of chunkKeys(values, size)) {
    for (const record of await load(chunk)) {
      results.push(record)
    }
  }
  return results
}

/**
 * The related rows behind one eager load, and whether the constraint narrowed
 * them with `select()`. The callback runs on the builder that is executed: it
 * is the caller's, and a probe would run it an extra time per load. A top-level
 * `orWhere()` in it widens the foreign-key filter, so a loader that groups on
 * something weaker (morphMany, on the morph id) filters the rows itself.
 */
export async function loadRelatedRecords(
  related: typeof Model,
  keys: readonly unknown[],
  clause: (chunk: readonly unknown[]) => Record<string, unknown>,
  queryOptions?: ModelQueryOptions,
  constraint?: EagerLoadConstraint,
): Promise<{ records: PlainObject[]; projected: boolean }> {
  // Raw: the caller groups these rows on a key column the related model may
  // cast, and the parent values it matches them against are raw.
  const rows = (chunk: readonly unknown[]): Promise<PlainObject[]> => {
    const query = related.newQuery(queryOptions).where(clause(chunk) as WhereClause)
    constraint?.(query)
    return query[RAW_RESULTS]() as Promise<PlainObject[]>
  }

  const size = maxInListSize(related.getAdapter())
  const whole = related.newQuery(queryOptions).where(clause(keys) as WhereClause)
  constraint?.(whole)
  const options = whole.getOptions()
  const projected = (options.selectFields?.length ?? 0) > 0

  // `limit`, `offset` and `orderBy` describe the whole result set, so a split IN
  // list would answer a different question per chunk — and a parent set large
  // enough can push that one list past the driver's limit.
  const describesWholeSet = options.limitValue !== undefined || options.offsetValue !== undefined || options.orderBy.length > 0
  if (keys.length <= size || describesWholeSet) {
    return { records: (await whole[RAW_RESULTS]()) as PlainObject[], projected }
  }

  return { records: await loadByChunks(keys, size, rows), projected }
}

export async function countByChunks(
  values: readonly unknown[],
  size: number,
  count: (chunk: readonly unknown[]) => Promise<Map<unknown, number>>,
): Promise<Map<unknown, number>> {
  // Chunks hold disjoint key sets, so no key is counted twice.
  return new Map(await loadByChunks(values, size, async (chunk) => Array.from(await count(chunk))))
}

export async function resolveModelReference(
  reference: typeof Model | (() => typeof Model | Promise<typeof Model>),
): Promise<typeof Model> {
  if (typeof reference === 'function' && 'prototype' in reference && reference.prototype instanceof Model) {
    return reference as typeof Model
  }

  return await (reference as () => typeof Model | Promise<typeof Model>)()
}
