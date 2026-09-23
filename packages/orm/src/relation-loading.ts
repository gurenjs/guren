import { RAW_RESULTS } from './internal-keys'
import type { Model, ModelQueryOptions, PlainObject, WhereClause } from './Model'
import type { EagerLoadConstraint } from './QueryBuilder'
import type {
  HasManyRelationDefinition, HasOneRelationDefinition, BelongsToRelationDefinition,
  BelongsToManyRelationDefinition, HasManyThroughRelationDefinition,
  MorphManyRelationDefinition, MorphToRelationDefinition,
} from './relation-definitions'
import {
  applyRelatedReadTransforms, distinctKeys, loadByChunks, loadRelatedRecords,
  maxInListSize, resolveModelReference,
} from './relation-records'

async function loadRelationData(
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

export async function loadHasMany(
  records: Array<PlainObject>,
  definition: HasManyRelationDefinition,
  queryOptions?: ModelQueryOptions,
  constraint?: EagerLoadConstraint,
): Promise<boolean> {
  const { foreignKey, localKey, name } = definition
  const related = await resolveModelReference(definition.related)
  return loadRelationData(records, name, related, localKey, foreignKey, true, queryOptions, constraint)
}

export async function loadHasOne(
  records: Array<PlainObject>,
  definition: HasOneRelationDefinition,
  queryOptions?: ModelQueryOptions,
  constraint?: EagerLoadConstraint,
): Promise<boolean> {
  const { foreignKey, localKey, name } = definition
  const related = await resolveModelReference(definition.related)
  return loadRelationData(records, name, related, localKey, foreignKey, false, queryOptions, constraint)
}

export async function loadBelongsTo(
  records: Array<PlainObject>,
  definition: BelongsToRelationDefinition,
  queryOptions?: ModelQueryOptions,
  constraint?: EagerLoadConstraint,
): Promise<boolean> {
  const { foreignKey, ownerKey, name } = definition
  const related = await resolveModelReference(definition.related)
  return loadRelationData(records, name, related, foreignKey, ownerKey, false, queryOptions, constraint)
}

export async function loadBelongsToMany(
  owner: Pick<typeof Model, 'getAdapter'>,
  records: Array<PlainObject>,
  definition: BelongsToManyRelationDefinition,
  queryOptions?: ModelQueryOptions,
  constraint?: EagerLoadConstraint,
): Promise<boolean> {
  const { pivotTable, foreignPivotKey, relatedPivotKey, parentKey, relatedKey, name } = definition
  const related = await resolveModelReference(definition.related)

  const parentValues = distinctKeys(records, parentKey)

  if (parentValues.length === 0) {
    for (const record of records) {
      record[name] = []
    }
    return false
  }

  const adapter = owner.getAdapter()
  const pivotRows = await loadByChunks(parentValues, maxInListSize(adapter), (chunk) =>
    adapter.findMany<PlainObject>(pivotTable, { where: { [foreignPivotKey]: chunk } as WhereClause }, queryOptions),
  )

  const pivotMap = new Map<unknown, unknown[]>()
  const allRelatedIds = new Set<unknown>()
  for (const row of pivotRows) {
    const fk = row[foreignPivotKey]
    const rk = row[relatedPivotKey]
    if (!pivotMap.has(fk)) pivotMap.set(fk, [])
    pivotMap.get(fk)!.push(rk)
    allRelatedIds.add(rk)
  }

  if (allRelatedIds.size === 0) {
    for (const record of records) {
      record[name] = []
    }
    return false
  }

  // The constraint filters the related rows, not the pivot lookup, and the
  // keys batched below are theirs rather than the parents'.
  const { records: relatedRecords, projected } = await loadRelatedRecords(
    related,
    Array.from(allRelatedIds),
    (chunk) => ({ [relatedKey]: chunk }),
    queryOptions,
    constraint,
  )

  const relatedMap = new Map<unknown, PlainObject>()
  for (const item of relatedRecords) {
    relatedMap.set(item[relatedKey], { ...item })
  }

  for (const record of records) {
    const pk = record[parentKey]
    if (pk == null) {
      record[name] = []
      continue
    }
    const relatedIds = pivotMap.get(pk) ?? []
    record[name] = relatedIds
      .map((id) => relatedMap.get(id))
      .filter((item): item is PlainObject => item != null)
  }

  return projected
}

export async function loadHasManyThrough(
  records: Array<PlainObject>,
  definition: HasManyThroughRelationDefinition,
  queryOptions?: ModelQueryOptions,
  constraint?: EagerLoadConstraint,
): Promise<boolean> {
  const { firstKey, secondKey, localKey, secondLocalKey, name } = definition
  const related = await resolveModelReference(definition.related)
  const through = await resolveModelReference(definition.through)

  const localValues = distinctKeys(records, localKey)

  if (localValues.length === 0) {
    for (const record of records) {
      record[name] = []
    }
    return false
  }

  const throughRecords = await loadByChunks(
    localValues,
    maxInListSize(through.getAdapter()),
    (chunk) => through.newQuery(queryOptions).where({ [firstKey]: chunk } as WhereClause)[RAW_RESULTS]() as Promise<PlainObject[]>,
  )

  const throughMap = new Map<unknown, unknown[]>()
  const allThroughIds = new Set<unknown>()
  for (const row of throughRecords) {
    const fk = row[firstKey]
    const tk = row[secondLocalKey]
    if (!throughMap.has(fk)) throughMap.set(fk, [])
    throughMap.get(fk)!.push(tk)
    allThroughIds.add(tk)
  }

  if (allThroughIds.size === 0) {
    for (const record of records) {
      record[name] = []
    }
    return false
  }

  // The constraint filters the related rows, not the intermediate lookup, and
  // the keys batched below are theirs rather than the parents'.
  const { records: relatedRecords, projected } = await loadRelatedRecords(
    related,
    Array.from(allThroughIds),
    (chunk) => ({ [secondKey]: chunk }),
    queryOptions,
    constraint,
  )

  const relatedByKey = new Map<unknown, PlainObject[]>()
  for (const item of relatedRecords) {
    const key = item[secondKey]
    if (!relatedByKey.has(key)) relatedByKey.set(key, [])
    relatedByKey.get(key)!.push({ ...item })
  }

  for (const record of records) {
    const lk = record[localKey]
    if (lk == null) {
      record[name] = []
      continue
    }
    const throughIds = throughMap.get(lk) ?? []
    const items: PlainObject[] = []
    for (const tid of throughIds) {
      const matched = relatedByKey.get(tid) ?? []
      items.push(...matched)
    }
    record[name] = items
  }

  return projected
}

export async function loadMorphMany(
  owner: { readonly name: string },
  records: Array<PlainObject>,
  definition: MorphManyRelationDefinition,
  queryOptions?: ModelQueryOptions,
  constraint?: EagerLoadConstraint,
): Promise<boolean> {
  const { morphName, localKey, name } = definition
  const related = await resolveModelReference(definition.related)
  const typeColumn = `${morphName}Type`
  const idColumn = `${morphName}Id`
  const parentType = owner.name

  const localValues = distinctKeys(records, localKey)

  if (localValues.length === 0) {
    for (const record of records) record[name] = []
    return false
  }

  const { records: allRelated, projected } = await loadRelatedRecords(
    related,
    localValues,
    (chunk) => ({ [typeColumn]: parentType, [idColumn]: chunk }),
    queryOptions,
    constraint,
  )

  const map = new Map<unknown, PlainObject[]>()
  for (const item of allRelated) {
    // Grouped on the type as well as the id: the query filters by type, but
    // a constraint callback may widen it (a top-level `orWhere` does).
    if (item[typeColumn] !== parentType) continue
    const key = item[idColumn]
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push({ ...item })
  }

  for (const record of records) {
    const key = record[localKey]
    record[name] = key != null ? (map.get(key) ?? []) : []
  }

  return projected
}

export async function loadMorphTo(
  morphMap: Record<string, typeof Model>,
  records: Array<PlainObject>,
  definition: MorphToRelationDefinition,
  queryOptions?: ModelQueryOptions,
  constraint?: EagerLoadConstraint,
): Promise<void> {
  const { morphName, name } = definition
  const typeColumn = `${morphName}Type`
  const idColumn = `${morphName}Id`

  const byType = new Map<string, unknown[]>()
  for (const record of records) {
    const type = record[typeColumn] as string
    const id = record[idColumn]
    if (!type || id == null) continue
    if (!byType.has(type)) byType.set(type, [])
    byType.get(type)!.push(id)
  }

  const resolved = new Map<string, Map<unknown, PlainObject>>()
  for (const [type, ids] of byType) {
    const modelClass = morphMap[type]
    if (!modelClass) continue
    const uniqueIds = Array.from(new Set(ids))
    // Runs once per morph target, so a constraint here may only reference
    // columns every target shares.
    const { records: results, projected } = await loadRelatedRecords(
      modelClass,
      uniqueIds,
      (chunk) => ({ id: chunk }),
      queryOptions,
      constraint,
    )
    const idMap = new Map<unknown, PlainObject>()
    for (const r of results) idMap.set(r.id, { ...r })
    applyRelatedReadTransforms(modelClass, Array.from(idMap.values()), projected)
    resolved.set(type, idMap)
  }

  for (const record of records) {
    const type = record[typeColumn] as string
    const id = record[idColumn]
    if (!type || id == null) {
      record[name] = null
      continue
    }
    record[name] = resolved.get(type)?.get(id) ?? null
  }
}
