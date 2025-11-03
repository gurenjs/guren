import { DrizzleAdapter } from './adapters/drizzle-adapter'

export type PlainObject = Record<string, unknown>

type RelationShape = Record<string, unknown>

export type WhereValue<Value> = Value | readonly Value[] | null

export type WhereClause<TRecord extends PlainObject = PlainObject> = Partial<{
  [K in keyof TRecord & string]?: WhereValue<TRecord[K]>
}>

export type OrderDirection = 'asc' | 'desc'

export type OrderDefinition<TRecord extends PlainObject = PlainObject> = {
  column: keyof TRecord & string
  direction: OrderDirection
}

export type OrderExpression<TRecord extends PlainObject = PlainObject> =
  | (keyof TRecord & string)
  | readonly [keyof TRecord & string, OrderDirection]
  | { column: keyof TRecord & string; direction?: OrderDirection }

export type OrderByInput<TRecord extends PlainObject = PlainObject> =
  | OrderExpression<TRecord>
  | readonly OrderExpression<TRecord>[]

export type OrderByClause<TRecord extends PlainObject = PlainObject> = readonly OrderDefinition<TRecord>[]

export interface FindManyOptions<TRecord extends PlainObject = PlainObject> {
  where?: WhereClause<TRecord>
  orderBy?: OrderByClause<TRecord>
}

export interface ORMAdapter {
  findMany<TRecord extends PlainObject = PlainObject>(table: unknown, options?: FindManyOptions<TRecord>): Promise<TRecord[]>
  findUnique<TRecord extends PlainObject = PlainObject>(table: unknown, where: WhereClause<TRecord>): Promise<TRecord | null>
  create<TRecord extends PlainObject = PlainObject>(table: unknown, data: PlainObject): Promise<TRecord>
  update?<TRecord extends PlainObject = PlainObject>(
    table: unknown,
    where: WhereClause<TRecord>,
    data: PlainObject,
  ): Promise<TRecord>
  delete?<TRecord extends PlainObject = PlainObject>(
    table: unknown,
    where: WhereClause<TRecord>,
  ): Promise<number | PlainObject | void>
}

/**
 * Minimal ActiveRecord-like wrapper around the configured ORM adapter. The API
 * mirrors a subset of Laravel's Eloquent helpers and can be expanded over time.
 */
export abstract class Model<TRecord extends PlainObject = PlainObject> {
  protected static ormAdapter: ORMAdapter = DrizzleAdapter
  protected static table: unknown
  static readonly recordType: unknown = undefined as unknown
  protected static relationDefinitions?: Map<string, RelationDefinition>
  static relationTypes: RelationShape = {}

  static useAdapter(adapter: ORMAdapter): void {
    this.ormAdapter = adapter
  }

  static getAdapter(): ORMAdapter {
    return this.ormAdapter
  }

  protected static async preparePersistencePayload(data: PlainObject): Promise<PlainObject> {
    return { ...data }
  }

  protected static getRelationDefinitions(): Map<string, RelationDefinition> {
    if (!Object.prototype.hasOwnProperty.call(this, 'relationDefinitions') || !this.relationDefinitions) {
      this.relationDefinitions = new Map()
    }

    return this.relationDefinitions
  }

  protected static getRelationDefinition(name: string): RelationDefinition | undefined {
    return this.getRelationDefinitions().get(name)
  }

  protected static resolveTable(): unknown {
    if (!this.table) {
      throw new Error(`${this.name}.table must be defined before using the model.`)
    }

    return this.table
  }

  static async all<T extends typeof Model>(this: T): Promise<Array<TRecordFor<T>>> {
    const table = this.resolveTable()
    return this.getAdapter().findMany(table) as Promise<Array<TRecordFor<T>>>
  }

  static async find<T extends typeof Model>(this: T, id: unknown, key = 'id'): Promise<TRecordFor<T> | null> {
    const table = this.resolveTable()
    const where = { [key]: id } as WhereClauseFor<T>
    return this.getAdapter().findUnique(table, where) as Promise<TRecordFor<T> | null>
  }

  static async where<T extends typeof Model>(this: T, where: WhereClauseFor<T>): Promise<TRecordFor<T>[]> {
    const table = this.resolveTable()
    return this.getAdapter().findMany(table, { where }) as Promise<TRecordFor<T>[]>
  }

  static hasMany<
    This extends typeof Model,
    Related extends typeof Model,
    ForeignKey extends keyof TRecordFor<Related> & string,
    LocalKey extends keyof TRecordFor<This> & string,
    Name extends RelationKeyOrString<This>,
  >(
    this: This,
    name: Name,
    related: Related,
    foreignKey: ForeignKey,
    localKey: LocalKey,
  ): void {
    const definitions = this.getRelationDefinitions()
    definitions.set(name, {
      type: 'hasMany',
      name,
      related,
      foreignKey,
      localKey,
    })
  }

  static belongsTo<
    This extends typeof Model,
    Related extends typeof Model,
    ForeignKey extends keyof TRecordFor<This> & string,
    OwnerKey extends keyof TRecordFor<Related> & string,
    Name extends RelationKeyOrString<This>,
  >(
    this: This,
    name: Name,
    related: Related,
    foreignKey: ForeignKey,
    ownerKey: OwnerKey,
  ): void {
    const definitions = this.getRelationDefinitions()
    definitions.set(name, {
      type: 'belongsTo',
      name,
      related,
      foreignKey,
      ownerKey,
    })
  }

  static async orderBy<T extends typeof Model>(
    this: T,
    order: OrderByInput<TRecordFor<T>>,
    where?: WhereClauseFor<T>,
  ): Promise<TRecordFor<T>[]> {
    const table = this.resolveTable()
    const orderBy = normalizeOrderBy(order)
    const options: FindManyOptions<TRecordFor<T>> = { orderBy }

    if (where && Object.keys(where).length > 0) {
      options.where = where
    }

    return this.getAdapter().findMany(table, options) as Promise<TRecordFor<T>[]>
  }

  static async create<T extends typeof Model>(this: T, data: PlainObject): Promise<TRecordFor<T>> {
    const table = this.resolveTable()
    const payload = await this.preparePersistencePayload(data)
    return this.getAdapter().create(table, payload) as Promise<TRecordFor<T>>
  }

  static async update<T extends typeof Model>(this: T, where: WhereClauseFor<T>, data: PlainObject): Promise<TRecordFor<T>> {
    const table = this.resolveTable()
    const adapter = this.getAdapter()
    if (!adapter.update) {
      throw new Error('Configured adapter does not support update operations.')
    }

    const payload = await this.preparePersistencePayload(data)
    return adapter.update(table, where, payload) as Promise<TRecordFor<T>>
  }

  static async delete<T extends typeof Model>(this: T, where: WhereClauseFor<T>): Promise<number | PlainObject | void> {
    const table = this.resolveTable()
    const adapter = this.getAdapter()
    if (!adapter.delete) {
      throw new Error('Configured adapter does not support delete operations.')
    }

    return adapter.delete(table, where)
  }

  static async with<T extends typeof Model, K extends RelationKey<T>>(
    this: T,
    relations: K | readonly K[],
    where?: WhereClauseFor<T>,
  ): Promise<Array<TRecordFor<T> & RelationTypePick<T, K | readonly K[]>>>

  static async with<T extends typeof Model, Names extends RelationNames>(
    this: T,
    relations: Names,
    where?: WhereClauseFor<T>,
  ): Promise<Array<TRecordFor<T> & RelationTypePick<T, Names>>> {
    const records = where ? await this.where(where) : await this.all()
    if (!records.length) {
      return records as Array<TRecordFor<T> & RelationTypePick<T, Names>>
    }

    const relationList = normalizeRelations(relations)
    if (relationList.length === 0) {
      return records as Array<TRecordFor<T> & RelationTypePick<T, Names>>
    }

    const copies = records.map((record) => ({ ...record }))
    for (const relationName of relationList) {
      await this.loadRelationInto(copies, relationName)
    }

    return copies as Array<TRecordFor<T> & RelationTypePick<T, Names>>
  }

  protected static async loadRelationInto<T extends typeof Model>(
    this: T,
    records: Array<PlainObject>,
    relationName: string,
  ): Promise<void> {
    const definition = this.getRelationDefinition(relationName)

    if (!definition) {
      throw new Error(`${this.name}: unknown relation "${relationName}".`)
    }

    if (definition.type === 'hasMany') {
      await this.loadHasMany(records, definition)
      return
    }

    if (definition.type === 'belongsTo') {
      await this.loadBelongsTo(records, definition)
      return
    }
  }

  protected static async loadHasMany(
    records: Array<PlainObject>,
    definition: HasManyRelationDefinition,
  ): Promise<void> {
    const { related, foreignKey, localKey, name } = definition
    const ownerValues = Array.from(
      new Set(records.map((record) => record[localKey]).filter((value): value is unknown => value !== undefined && value !== null)),
    )

    if (ownerValues.length === 0) {
      records.forEach((record) => {
        record[name] = []
      })
      return
    }

    const relatedRecords = await related.where({ [foreignKey]: ownerValues } as WhereClauseFor<typeof related>)
    const grouped = new Map<unknown, PlainObject[]>()

    for (const item of relatedRecords as PlainObject[]) {
      const key = item[foreignKey]
      if (!grouped.has(key)) {
        grouped.set(key, [])
      }
      grouped.get(key)?.push({ ...item })
    }

    records.forEach((record) => {
      const key = record[localKey]
      record[name] = grouped.get(key) ?? []
    })
  }

  protected static async loadBelongsTo(
    records: Array<PlainObject>,
    definition: BelongsToRelationDefinition,
  ): Promise<void> {
    const { related, foreignKey, ownerKey, name } = definition
    const foreignValues = Array.from(
      new Set(records.map((record) => record[foreignKey]).filter((value): value is unknown => value !== undefined && value !== null)),
    )

    if (foreignValues.length === 0) {
      records.forEach((record) => {
        record[name] = null
      })
      return
    }

    const relatedRecords = await related.where({ [ownerKey]: foreignValues } as WhereClauseFor<typeof related>)
    const index = new Map<unknown, PlainObject>()
    for (const item of relatedRecords as PlainObject[]) {
      index.set(item[ownerKey], { ...item })
    }

    records.forEach((record) => {
      const key = record[foreignKey]
      record[name] = key == null ? null : index.get(key) ?? null
    })
  }
}

type TRecordFor<T extends typeof Model> = T extends { recordType: infer R }
  ? R extends PlainObject
    ? R
    : PlainObject
  : PlainObject

type WhereClauseFor<T extends typeof Model> = WhereClause<TRecordFor<T>>

type RelationNames = string | readonly string[]

type RelationTypesFor<T extends typeof Model> = T extends { relationTypes: infer R }
  ? R extends RelationShape
    ? R
    : {}
  : {}

type RelationKey<T extends typeof Model> = keyof RelationTypesFor<T> & string

type RelationKeyOrString<T extends typeof Model> = RelationKey<T> extends never ? string : RelationKey<T>

type RelationNameUnion<Names> = Names extends readonly (infer Items)[] ? Items : Names

type RelationTypePick<T extends typeof Model, Names> = RelationNameUnion<Names> extends infer Keys
  ? Keys extends string
    ? { [K in Keys & keyof RelationTypesFor<T>]: RelationTypesFor<T>[K] }
    : {}
  : {}

interface BaseRelationDefinition {
  type: 'hasMany' | 'belongsTo'
  name: string
  related: typeof Model
}

interface HasManyRelationDefinition extends BaseRelationDefinition {
  type: 'hasMany'
  foreignKey: string
  localKey: string
}

interface BelongsToRelationDefinition extends BaseRelationDefinition {
  type: 'belongsTo'
  foreignKey: string
  ownerKey: string
}

type RelationDefinition = HasManyRelationDefinition | BelongsToRelationDefinition

export type HasManyRelationResult<T extends typeof Model> = Array<TRecordFor<T>>

export type BelongsToRelationResult<T extends typeof Model> = TRecordFor<T> | null

export type HasManyRecord<TRecord extends PlainObject> = TRecord[]

export type BelongsToRecord<TRecord extends PlainObject> = TRecord | null

function normalizeOrderBy<TRecord extends PlainObject>(order: OrderByInput<TRecord>): OrderByClause<TRecord> {
  if (Array.isArray(order) && !isOrderTuple(order)) {
    return order.map((expression) => toOrderDefinition(expression)) as OrderByClause<TRecord>
  }

  return [toOrderDefinition(order as OrderExpression<TRecord>)]
}

function toOrderDefinition<TRecord extends PlainObject>(expression: OrderExpression<TRecord>): OrderDefinition<TRecord> {
  if (typeof expression === 'string') {
    return { column: expression, direction: 'asc' }
  }

  if (isOrderTuple(expression)) {
    const [column, direction] = expression
    return { column, direction }
  }

  return {
    column: expression.column,
    direction: expression.direction ?? 'asc',
  }
}

function isOrderTuple<TRecord extends PlainObject>(value: unknown): value is readonly [keyof TRecord & string, OrderDirection] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'string' &&
    (value[1] === 'asc' || value[1] === 'desc')
  )
}

function normalizeRelations(relations: RelationNames): string[] {
  if (Array.isArray(relations)) {
    return relations.map((relation) => relation.toString()).filter(Boolean)
  }

  if (typeof relations === 'string' && relations) {
    return [relations]
  }

  return []
}
