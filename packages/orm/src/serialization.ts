import type { AccessorDefinitions } from './attributes'
import { RELATION_DEFINITIONS } from './internal-keys'
import type { Model, PlainObject } from './Model'
import type { RelationDefinition } from './relation-definitions'
import { knownModelReference, knownMorphTarget } from './relation-records'

/** Serializes a record for JSON output: appends, then visible/hidden filtering. */
export function serializeRecord(
  record: PlainObject,
  options: {
    hidden?: string[]
    visible?: string[]
    appends?: string[]
    accessors?: AccessorDefinitions
  },
): PlainObject {
  let result = { ...record }

  if (options.appends && options.accessors) {
    // The read path runs every accessor, so an appended key is usually already
    // on the record. The loop still serves a row `select()` narrowed, where the
    // accessors were skipped, and a record that never came from a read.
    for (const key of options.appends) {
      if (key in result) continue
      const accessor = options.accessors[key]
      if (accessor) result[key] = accessor(result)
    }
  }

  if (options.visible && options.visible.length > 0) {
    const filtered: PlainObject = {}
    for (const key of options.visible) {
      if (key in result) filtered[key] = result[key]
    }
    result = filtered
  } else if (options.hidden && options.hidden.length > 0) {
    for (const key of options.hidden) {
      delete result[key]
    }
  }

  return result
}

/** Serialize an array of records. */
export function serializeRecords(
  records: PlainObject[],
  options: Parameters<typeof serializeRecord>[1],
): PlainObject[] {
  return records.map((r) => serializeRecord(r, options))
}

type ModelClass = typeof Model
type RelationDefinitions = ReadonlyMap<string, RelationDefinition>

interface RowEntry {
  output: PlainObject
  done: boolean
}

/** One per `serialize()`/`serializeMany()` call, so a row shared by several parents is filtered once. */
export interface RelationRowWalk {
  readonly morphMap: Readonly<Record<string, ModelClass>> | undefined
  memo?: Map<ModelClass, Map<PlainObject, RowEntry>>
}

/**
 * Filters the relation rows on `serialized` (a copy `serializeRecord` made of
 * `source`) by each related model's own `hidden`/`visible`, at every depth.
 * Only keys present on the rows are visited; untouched values keep their
 * references, and no input is written to.
 */
export function serializeLoadedRelations(
  model: ModelClass,
  source: PlainObject,
  serialized: PlainObject,
  walk: RelationRowWalk,
): PlainObject {
  const definitions = model[RELATION_DEFINITIONS]()
  if (definitions.size === 0) return serialized

  for (const key in serialized) {
    const definition = definitions.get(key)
    if (definition === undefined) continue
    const value = serialized[key]
    const filtered = filterRelationValue(relatedModelOf(definition, source, value, walk.morphMap), value, walk)
    if (filtered !== value) serialized[key] = filtered
  }
  return serialized
}

/**
 * The related model, read without calling a lazy reference: a thunk no load
 * has resolved yields `undefined`. A morphTo target is the model its load
 * resolved, since the holder's casts or accessors may rewrite the type column
 * afterwards; a row no load tagged falls back to that column.
 */
function relatedModelOf(
  definition: RelationDefinition,
  holder: PlainObject,
  value: unknown,
  morphMap: RelationRowWalk['morphMap'],
): ModelClass | undefined {
  if (definition.type !== 'morphTo') return knownModelReference(definition.related)
  const loaded = knownMorphTarget(value)
  if (loaded) return loaded
  const type = holder[`${definition.morphName}Type`]
  return typeof type === 'string' && morphMap && Object.hasOwn(morphMap, type) ? morphMap[type] : undefined
}

function hasColumnFilter(model: ModelClass): boolean {
  return (model.visible?.length ?? 0) > 0 || (model.hidden?.length ?? 0) > 0
}

function isRow(value: unknown): value is PlainObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function holdsRelation(definitions: RelationDefinitions, row: PlainObject): boolean {
  for (const key in row) {
    if (definitions.has(key)) return true
  }
  return false
}

function filterRelationValue(model: ModelClass | undefined, value: unknown, walk: RelationRowWalk): unknown {
  if (!model || value === null || typeof value !== 'object') return value

  const definitions = model[RELATION_DEFINITIONS]()
  const filtered = hasColumnFilter(model)
  if (!filtered && definitions.size === 0) return value

  if (!Array.isArray(value)) {
    return isRow(value) ? filterRow(model, definitions, filtered, value, walk) : value
  }

  let copy: unknown[] | undefined
  for (let i = 0; i < value.length; i++) {
    const item: unknown = value[i]
    const next = isRow(item) ? filterRow(model, definitions, filtered, item, walk) : item
    if (copy) {
      copy.push(next)
    } else if (next !== item) {
      copy = value.slice(0, i)
      copy.push(next)
    }
  }
  return copy ?? value
}

function filterRow(
  model: ModelClass,
  definitions: RelationDefinitions,
  filtered: boolean,
  row: PlainObject,
  walk: RelationRowWalk,
): PlainObject {
  // Nothing to drop here and nothing below to walk: no memo entry, so a cycle
  // can only pass through rows that are registered before their walk.
  if (!filtered && !holdsRelation(definitions, row)) return row

  walk.memo ??= new Map()
  let rows = walk.memo.get(model)
  if (!rows) {
    rows = new Map()
    walk.memo.set(model, rows)
  }

  const seen = rows.get(row)
  if (seen) {
    // Reached again through a cycle: the frame still filling this row writes
    // into the copy handed out here, so the back-reference never sees the source.
    if (!seen.done && seen.output === row) seen.output = { ...row }
    return seen.output
  }

  const entry: RowEntry = { output: filtered ? filterColumns(model, definitions, row, walk.morphMap) : row, done: false }
  rows.set(row, entry)

  for (const key in entry.output) {
    const definition = definitions.get(key)
    if (definition === undefined) continue
    const value = row[key]
    const next = filterRelationValue(relatedModelOf(definition, row, value, walk.morphMap), value, walk)
    if (next === value) continue
    if (entry.output === row) entry.output = { ...row }
    entry.output[key] = next
  }

  entry.done = true
  return entry.output
}

/**
 * A related row's own columns: `visible` keeps loaded order and, beside the
 * columns it names, the model's relations it can filter in turn unless
 * `hidden` names them; otherwise `hidden` keys go. Appends are not computed.
 */
function filterColumns(
  model: ModelClass,
  definitions: RelationDefinitions,
  row: PlainObject,
  morphMap: RelationRowWalk['morphMap'],
): PlainObject {
  const hidden = model.hidden
  const visible = model.visible
  const kept: PlainObject = {}

  if (visible && visible.length > 0) {
    for (const key in row) {
      if (visible.includes(key)) {
        kept[key] = row[key]
        continue
      }
      const definition = definitions.get(key)
      if (definition && !hidden?.includes(key) && relatedModelOf(definition, row, row[key], morphMap)) kept[key] = row[key]
    }
    return kept
  }

  if (!hidden?.some((key) => key in row)) return row
  for (const key in row) {
    if (!hidden.includes(key)) kept[key] = row[key]
  }
  return kept
}
