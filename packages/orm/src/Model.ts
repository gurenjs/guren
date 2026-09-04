import { DrizzleAdapter } from './adapters/drizzle-adapter'
import { applyAccessors, applyMutators } from './attributes'
import type { AccessorDefinitions, MutatorDefinitions } from './attributes'
import { GlobalScopeRegistry } from './GlobalScopeRegistry'
import type { ScopeFunction } from './GlobalScopeRegistry'
import { executeHook } from './hooks'
import type { ModelHooks } from './hooks'
import { executeObservers } from './ModelObserver'
import type { ModelObserver, ModelObserverConstructor } from './ModelObserver'
import { ModelNotFoundException } from './ModelNotFoundException'
import { QueryBuilder, PREPARED_UPDATE } from './QueryBuilder'
import type {
  EagerLoadConstraint,
  EagerLoadConstraints,
  WhereGroupCallback,
  WhereOperator,
} from './QueryBuilder'
import { serializeRecord, serializeRecords } from './serialization'
import { MassAssignmentException } from './MassAssignmentException'

export type PlainObject = Record<string, unknown>

type RelationShape = Record<string, unknown>

type TableShape<TSelect extends PlainObject = PlainObject, TInsert extends PlainObject = PlainObject> = {
  $inferSelect: TSelect
  $inferInsert?: TInsert
}

export const DEFAULT_PAGINATION_SIZE = 15

export type InferModelRecord<TTable> = TTable extends { $inferSelect: infer TRecord }
  ? TRecord extends PlainObject
    ? TRecord
    : PlainObject
  : PlainObject

export type InferModelInsert<TTable> = TTable extends { $inferInsert: infer TInsert }
  ? TInsert extends PlainObject
    ? TInsert
    : PlainObject
  : PlainObject

export type CastType = 'json' | 'date' | 'boolean' | 'number' | 'string'

export type WhereValue<Value> = Value | readonly Value[] | null

/** A single value is an equality test, an array an IN; keys are AND-ed. */
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
  limit?: number
  offset?: number
}

export interface PaginateOptions<TRecord extends PlainObject = PlainObject> {
  page?: number
  perPage?: number
  where?: WhereClause<TRecord>
  orderBy?: OrderByInput<TRecord>
}

export interface ModelPaginationMeta {
  total: number
  perPage: number
  currentPage: number
  totalPages: number
  hasMore: boolean
  from: number
  to: number
}

export interface PaginatedResult<TRecord extends PlainObject = PlainObject> {
  data: TRecord[]
  meta: ModelPaginationMeta
}

/** Interface for ORM adapters that power the Model class; DrizzleAdapter by default. */
export interface ORMAdapter {
  transaction?<TResult>(callback: (trx: unknown) => Promise<TResult>): Promise<TResult>
  findMany<TRecord extends PlainObject = PlainObject>(
    table: unknown,
    options?: FindManyOptions<TRecord>,
    queryOptions?: AdapterQueryOptions,
  ): Promise<TRecord[]>
  findUnique<TRecord extends PlainObject = PlainObject>(
    table: unknown,
    where: WhereClause<TRecord>,
    queryOptions?: AdapterQueryOptions,
  ): Promise<TRecord | null>
  create<TRecord extends PlainObject = PlainObject>(
    table: unknown,
    data: PlainObject,
    writeOptions?: AdapterQueryOptions,
  ): Promise<TRecord>
  update?<TRecord extends PlainObject = PlainObject>(
    table: unknown,
    where: WhereClause<TRecord>,
    data: PlainObject,
    writeOptions?: AdapterQueryOptions,
  ): Promise<TRecord>
  delete?<TRecord extends PlainObject = PlainObject>(
    table: unknown,
    where: WhereClause<TRecord>,
    writeOptions?: AdapterQueryOptions,
  ): Promise<number | PlainObject | void>
  count?<TRecord extends PlainObject = PlainObject>(
    table: unknown,
    where?: WhereClause<TRecord>,
    queryOptions?: AdapterQueryOptions,
  ): Promise<number>
}

export interface AdapterQueryOptions {
  trx?: unknown
}

export type ModelWriteOptions = AdapterQueryOptions
export type ModelQueryOptions = AdapterQueryOptions
export type TransactionHandle = NonNullable<AdapterQueryOptions['trx']>

type SelectFrom<TDatabase> = TDatabase extends { select: (...args: any[]) => infer TSelect } // eslint-disable-line @typescript-eslint/no-explicit-any
  ? TSelect extends { from: (...args: any[]) => infer TResult } // eslint-disable-line @typescript-eslint/no-explicit-any
    ? TResult
    : never
  : never

/**
 * ActiveRecord-style base class for database models. Prefer `defineModel(table)`,
 * which infers the type markers; extending `Model` directly means setting
 * `static table` and redeclaring `recordType`/`createType` by hand.
 */
export abstract class Model<TRecord extends PlainObject = PlainObject> {
  protected static ormAdapter: ORMAdapter = DrizzleAdapter
  protected static table: unknown
  /** Type marker for TypeScript inference. Set by `defineModel()`; when extending `Model` directly, redeclare as `declare static readonly recordType: YourRecordType`. */
  static readonly recordType: unknown = undefined as unknown
  /** Type marker for insert/update payload inference. Set by `defineModel()`; when extending `Model` directly, redeclare as `declare static readonly createType: YourCreateType`. */
  static readonly createType: unknown = undefined as unknown
  protected static relationDefinitions?: Map<string, RelationDefinition>
  static relationTypes: RelationShape = {}

  /**
   * Reusable query constraints, applied by name with
   * `Post.scope('published').scope('popular')`.
   */
  static scopes?: Record<string, (q: QueryBuilder<any>) => QueryBuilder<any>> // eslint-disable-line @typescript-eslint/no-explicit-any

  /**
   * Applied to every query on this model, and — unlike a named global scope —
   * never removable with `withoutGlobalScope()`.
   */
  static defaultScope?: (q: QueryBuilder<any>) => QueryBuilder<any> // eslint-disable-line @typescript-eslint/no-explicit-any

  /** Lifecycle hooks firing around create, update and delete. */
  static hooks?: ModelHooks

  /** Attribute casts, applied both on read and on write. */
  static casts?: Record<string, CastType>

  /**
   * Mass-assignment allowlist. When set, any other key in `create()`/`update()`
   * input throws a MassAssignmentException rather than being discarded, so
   * bugs and injection attempts surface; `forceCreate()`/`forceUpdate()` are
   * the trusted-data escape. Independent of it, `id` is always stripped and
   * `deniedFields()` always throws.
   */
  static fillable?: string[]

  /**
   * Fields that can never be mass-assigned, whatever `fillable` says. Resolved
   * at call time so a subclass can derive them from its own configuration
   * (`AuthenticatableModel` contributes its password-hash column).
   */
  protected static deniedFields(): string[] {
    return []
  }

  /** Computed attributes, applied after a record is read. */
  static accessors?: AccessorDefinitions

  /** Attribute transforms applied before persistence. */
  static mutators?: MutatorDefinitions

  /** Fields to exclude from serialization output. */
  static hidden?: string[]

  /** Serialization allowlist; takes precedence over `hidden`. */
  static visible?: string[]

  /** Accessor names to add to serialization output. */
  static appends?: string[]

  protected static observers?: ModelObserver[]

  protected static globalScopeRegistry?: GlobalScopeRegistry

  static useAdapter(adapter: ORMAdapter): void {
    this.ormAdapter = adapter
  }

  static getAdapter(): ORMAdapter {
    return this.ormAdapter
  }

  /**
   * @example
   * await User.transaction(async (trx) => User.create({ name: 'John' }, { trx }))
   */
  static async transaction<T extends typeof Model, TResult>(
    this: T,
    callback: (trx: TransactionHandle, scope: TransactionModelScope<T>) => Promise<TResult>,
  ): Promise<TResult> {
    const adapter = this.getAdapter()
    if (typeof adapter.transaction !== 'function') {
      throw new Error('Configured adapter does not support transactions.')
    }
    return adapter.transaction((trx) => callback(trx as TransactionHandle, this.inTransaction(trx as TransactionHandle)))
  }

  /** A model scope that forwards `trx` to every query and write on it. */
  static inTransaction<T extends typeof Model>(this: T, trx: TransactionHandle): TransactionModelScope<T> {
    const where: TransactionModelScope<T>['where'] = (
      fieldOrConditions: FieldFor<T> | WhereClauseFor<T> | WhereGroupCallback<TRecordFor<T>>,
      operatorOrValue?: unknown,
      value?: unknown,
    ) => {
      if (typeof fieldOrConditions === 'function') {
        return this.newQuery({ trx }).where(fieldOrConditions)
      }

      if (typeof fieldOrConditions === 'object' && fieldOrConditions !== null) {
        return this.newQuery({ trx }).where(fieldOrConditions as Partial<Record<keyof TRecordFor<T> & string, unknown>>)
      }

      if (value !== undefined) {
        return this.newQuery({ trx }).where(fieldOrConditions as keyof TRecordFor<T> & string, operatorOrValue as WhereOperator, value)
      }

      return this.newQuery({ trx }).where(
        fieldOrConditions as keyof TRecordFor<T> & string,
        operatorOrValue as TRecordFor<T>[keyof TRecordFor<T> & string],
      )
    }

    return {
      trx,
      all: () => this.all({ trx }),
      find: (id) => this.find(id as TRecordFor<T>[keyof TRecordFor<T> & string], undefined, { trx }),
      findOrFail: (id) => this.findOrFail(id as TRecordFor<T>[keyof TRecordFor<T> & string], undefined, { trx }),
      first: (where) => this.first(where, { trx }),
      where,
      newQuery: () => this.newQuery({ trx }),
      create: (data) => this.create(data, { trx }),
      update: (where, data) => this.update(where, data, { trx }),
      delete: (where) => this.delete(where, { trx }),
      paginate: (options) => this.paginate(options, { trx }),
    }
  }

  static observe(ObserverClass: ModelObserverConstructor): void {
    if (!Object.prototype.hasOwnProperty.call(this, 'observers') || !this.observers) {
      this.observers = []
    }
    this.observers.push(new ObserverClass())
  }

  static clearObservers(): void {
    this.observers = []
  }

  /**
   * The registry this class may mutate, created on first write and seeded from
   * the inherited one: the read paths resolve it through the prototype chain,
   * so starting empty would shadow and drop every inherited scope (SoftDeletes
   * then `addGlobalScope('tenant')`). The copy is a snapshot — scopes added to
   * the parent afterwards never reach the subclass.
   */
  protected static getGlobalScopes(): GlobalScopeRegistry {
    if (!Object.prototype.hasOwnProperty.call(this, 'globalScopeRegistry') || !this.globalScopeRegistry) {
      const inherited = this.globalScopeRegistry
      this.globalScopeRegistry = inherited ? inherited.clone() : new GlobalScopeRegistry()
    }
    return this.globalScopeRegistry
  }

  static addGlobalScope(name: string, fn: ScopeFunction): void {
    this.getGlobalScopes().add(name, fn)
  }

  static removeGlobalScope(name: string): void {
    this.getGlobalScopes().remove(name)
  }

  /**
   * Only *named* scopes can be excluded: `defaultScope` is re-applied whatever
   * this is asked to drop, so a mixin whose filter must be opt-out-able has to
   * register a named scope and nothing else.
   */
  static withoutGlobalScope<T extends typeof Model>(this: T, ...names: string[]): QueryBuilder<TRecordFor<T>> {
    const builder = new QueryBuilder<TRecordFor<T>>(this)
    if (this.defaultScope) {
      this.defaultScope(builder)
    }
    this.getGlobalScopes().apply(builder, names)
    return builder
  }

  /** A query with no global scopes applied, `defaultScope` included. */
  static withoutGlobalScopes<T extends typeof Model>(this: T): QueryBuilder<TRecordFor<T>> {
    return new QueryBuilder<TRecordFor<T>>(this)
  }

  /** Applies hidden/visible filtering, accessors and appends. */
  static serialize<T extends typeof Model>(this: T, record: TRecordFor<T>): PlainObject {
    return serializeRecord(record, {
      hidden: this.hidden,
      visible: this.visible,
      appends: this.appends,
      accessors: this.accessors,
    })
  }

  static serializeMany<T extends typeof Model>(this: T, records: TRecordFor<T>[]): PlainObject[] {
    return serializeRecords(records, {
      hidden: this.hidden,
      visible: this.visible,
      appends: this.appends,
      accessors: this.accessors,
    })
  }

  static applyCasts<T extends PlainObject>(record: T): T {
    const castDefs = this.casts
    if (!castDefs) return record

    const castKeys = Object.keys(castDefs)
    if (!castKeys.some((key) => key in record && record[key] != null)) {
      return record
    }

    const result = { ...record }
    for (const [field, castType] of Object.entries(castDefs)) {
      if (!(field in result)) continue
      const value = result[field]
      if (value == null) continue

      switch (castType) {
        case 'json': {
          if (typeof value === 'string') {
            try {
              result[field as keyof T] = JSON.parse(value) as T[keyof T]
            } catch {
            }
          }
          break
        }
        case 'date': {
          if (!(value instanceof Date)) {
            result[field as keyof T] = new Date(value as string | number) as T[keyof T]
          }
          break
        }
        case 'boolean': {
          result[field as keyof T] = Boolean(value) as T[keyof T]
          break
        }
        case 'number': {
          result[field as keyof T] = Number(value) as T[keyof T]
          break
        }
        case 'string': {
          result[field as keyof T] = String(value) as T[keyof T]
          break
        }
      }
    }

    return result
  }

  /** Read-time transforms, in order: casts then accessors. */
  protected static applyReadTransforms<T extends PlainObject>(record: T): T {
    let result = record
    if (this.casts) result = this.applyCasts(result)
    if (this.accessors) result = applyAccessors(result, this.accessors)
    return result
  }

  /**
   * In order: `deniedFields()` throws, checked on the raw input so no later
   * rule can swallow them; `id` is stripped silently; then, with `fillable`
   * set, anything outside it throws.
   */
  static filterFillable(data: PlainObject): PlainObject {
    const denied = this.deniedFields().filter((field) => field in data)
    if (denied.length > 0) {
      throw new MassAssignmentException(this.name, denied, { reason: 'denied' })
    }

    let candidate = data
    if ('id' in candidate) {
      const { id: _id, ...rest } = candidate
      candidate = rest
    }

    const fillableFields = this.fillable
    if (!fillableFields) {
      return candidate
    }

    const blocked = Object.keys(candidate).filter((key) => !fillableFields.includes(key))
    if (blocked.length > 0) {
      throw new MassAssignmentException(this.name, blocked)
    }

    const filtered: PlainObject = {}
    for (const key of fillableFields) {
      if (key in candidate) {
        filtered[key] = candidate[key]
      }
    }
    return filtered
  }

  protected static async preparePersistencePayload(data: PlainObject): Promise<PlainObject> {
    let result = { ...data }

    if (this.mutators) {
      result = applyMutators(result, this.mutators)
    }

    const castDefs = this.casts
    if (castDefs) {
      for (const [field, castType] of Object.entries(castDefs)) {
        if (!(field in result)) continue
        const value = result[field]
        if (value == null) continue

        switch (castType) {
          case 'json': {
            if (typeof value !== 'string') {
              result[field] = JSON.stringify(value)
            }
            break
          }
          case 'date': {
            if (value instanceof Date) {
              result[field] = value.toISOString()
            }
            break
          }
          case 'boolean': {
            result[field] = Boolean(value)
            break
          }
          case 'number': {
            result[field] = Number(value)
            break
          }
          case 'string': {
            result[field] = String(value)
            break
          }
        }
      }
    }
    return result
  }

  /** @internal Lets QueryBuilder bulk updates run the same payload preparation as `Model.update()`. */
  static async prepareBulkPersistencePayload(data: PlainObject): Promise<PlainObject> {
    return this.preparePersistencePayload(data)
  }

  protected static getRelationDefinitions(): Map<string, RelationDefinition> {
    if (!Object.prototype.hasOwnProperty.call(this, 'relationDefinitions') || !this.relationDefinitions) {
      this.relationDefinitions = new Map()
    }

    return this.relationDefinitions
  }

  /** @internal */
  static getRelationDefinition(name: string): RelationDefinition | undefined {
    return this.getRelationDefinitions().get(name)
  }

  static resolveTable(): unknown {
    if (!this.table) {
      throw new Error(`${this.name}.table must be defined before using the model.`)
    }

    return this.table
  }

  static async all<T extends typeof Model>(this: T, queryOptions?: ModelQueryOptions): Promise<Array<TRecordFor<T>>> {
    if (this.hasScopes()) {
      return this.newQuery(queryOptions).get()
    }
    const table = this.resolveTable()
    const records = await this.getAdapter().findMany(table, undefined, queryOptions) as Array<TRecordFor<T>>
    if (this.casts || this.accessors) {
      return records.map((r) => this.applyReadTransforms(r))
    }
    return records
  }

  static async find<T extends typeof Model>(
    this: T,
    id: TRecordFor<T>[keyof TRecordFor<T> & string],
    key: keyof TRecordFor<T> & string = 'id' as keyof TRecordFor<T> & string,
    queryOptions?: ModelQueryOptions,
  ): Promise<TRecordFor<T> | null> {
    if (this.hasScopes()) {
      return this.newQuery(queryOptions).where(key, id as TRecordFor<T>[typeof key]).first()
    }
    const table = this.resolveTable()
    const where = { [key]: id } as WhereClauseFor<T>
    const record = await this.getAdapter().findUnique(table, where, queryOptions) as TRecordFor<T> | null
    if (record && (this.casts || this.accessors)) {
      return this.applyReadTransforms(record)
    }
    return record
  }

  /** @throws ModelNotFoundException (404) when no record matches. */
  static async findOrFail<T extends typeof Model>(
    this: T,
    id: TRecordFor<T>[keyof TRecordFor<T> & string],
    key: keyof TRecordFor<T> & string = 'id' as keyof TRecordFor<T> & string,
    queryOptions?: ModelQueryOptions,
  ): Promise<TRecordFor<T>> {
    const record = await this.find(id, key, queryOptions)
    if (record == null) {
      throw new ModelNotFoundException(this.name, id, key)
    }
    return record
  }

  static async findWith<T extends typeof Model, K extends RelationPath<T>>(
    this: T,
    id: TRecordFor<T>[keyof TRecordFor<T> & string],
    relations: K | readonly K[],
    key?: keyof TRecordFor<T> & string,
    queryOptions?: ModelQueryOptions,
  ): Promise<(TRecordFor<T> & RelationTypePick<T, K | readonly K[]>) | null>

  static async findWith<T extends typeof Model, Names extends RelationNames>(
    this: T,
    id: TRecordFor<T>[keyof TRecordFor<T> & string],
    relations: Names,
    key?: keyof TRecordFor<T> & string,
    queryOptions?: ModelQueryOptions,
  ): Promise<(TRecordFor<T> & RelationTypePick<T, Names>) | null> {
    const record = await this.find(id, key, queryOptions)
    if (record == null) return null

    const relationList = normalizeRelations(relations)
    if (relationList.length === 0) {
      return record as TRecordFor<T> & RelationTypePick<T, Names>
    }

    const copy = { ...record }
    await this.loadRelationsInto([copy], relationList, queryOptions)
    return copy as TRecordFor<T> & RelationTypePick<T, Names>
  }

  /**
   * Relations accept dot-notation paths (`comments.author`).
   * @throws ModelNotFoundException when no record matches.
   */
  static async findWithOrFail<T extends typeof Model, K extends RelationPath<T>>(
    this: T,
    id: TRecordFor<T>[keyof TRecordFor<T> & string],
    relations: K | readonly K[],
    key?: keyof TRecordFor<T> & string,
    queryOptions?: ModelQueryOptions,
  ): Promise<TRecordFor<T> & RelationTypePick<T, K | readonly K[]>>

  static async findWithOrFail<T extends typeof Model, Names extends RelationNames>(
    this: T,
    id: TRecordFor<T>[keyof TRecordFor<T> & string],
    relations: Names,
    key?: keyof TRecordFor<T> & string,
    queryOptions?: ModelQueryOptions,
  ): Promise<TRecordFor<T> & RelationTypePick<T, Names>> {
    const record = await this.findOrFail(id, key, queryOptions)

    const relationList = normalizeRelations(relations)
    if (relationList.length === 0) {
      return record as TRecordFor<T> & RelationTypePick<T, Names>
    }

    const copy = { ...record }
    await this.loadRelationsInto([copy], relationList, queryOptions)
    return copy as TRecordFor<T> & RelationTypePick<T, Names>
  }

  static async first<T extends typeof Model>(
    this: T,
    where?: WhereClauseFor<T>,
    queryOptions?: ModelQueryOptions,
  ): Promise<TRecordFor<T> | null> {
    if (this.hasScopes()) {
      const builder = this.newQuery(queryOptions).limit(1)
      if (where) {
        builder.where(where as Partial<Record<string, unknown>>)
      }
      const results = await builder.get()
      return (results[0] ?? null) as TRecordFor<T> | null
    }
    const table = this.resolveTable()
    const results = await this.getAdapter().findMany(table, { where, limit: 1 }, queryOptions)
    const record = (results[0] ?? null) as TRecordFor<T> | null
    if (record && (this.casts || this.accessors)) {
      return this.applyReadTransforms(record)
    }
    return record
  }

  /**
   * Returns a thenable QueryBuilder, so it can be chained or awaited directly.
   *
   * @example
   * await User.where({ status: 'active' })
   * await Post.where('views', '>', 100).orderBy('createdAt', 'desc').get()
   */
  static where<T extends typeof Model>(this: T, callback: WhereGroupCallback<TRecordFor<T>>): QueryBuilder<TRecordFor<T>>
  static where<T extends typeof Model>(this: T, conditions: WhereClauseFor<T>): QueryBuilder<TRecordFor<T>>
  static where<T extends typeof Model>(this: T, field: keyof TRecordFor<T> & string, value: unknown): QueryBuilder<TRecordFor<T>>
  static where<T extends typeof Model>(this: T, field: keyof TRecordFor<T> & string, operator: WhereOperator, value: unknown): QueryBuilder<TRecordFor<T>>
  static where<T extends typeof Model>(
    this: T,
    fieldOrConditions: (keyof TRecordFor<T> & string) | WhereClauseFor<T> | WhereGroupCallback<TRecordFor<T>>,
    operatorOrValue?: unknown,
    value?: unknown,
  ): QueryBuilder<TRecordFor<T>> {
    const builder = this.newQuery()

    if (typeof fieldOrConditions === 'function') {
      return builder.where(fieldOrConditions)
    }

    if (typeof fieldOrConditions === 'object' && fieldOrConditions !== null) {
      return builder.where(fieldOrConditions as Partial<Record<keyof TRecordFor<T> & string, unknown>>)
    }

    if (arguments.length === 3) {
      return builder.where(fieldOrConditions as keyof TRecordFor<T> & string, operatorOrValue as WhereOperator, value)
    }

    return builder.where(
      fieldOrConditions as keyof TRecordFor<T> & string,
      operatorOrValue as TRecordFor<T>[keyof TRecordFor<T> & string],
    )
  }

  static whereNull<T extends typeof Model>(
    this: T,
    field: keyof TRecordFor<T> & string,
  ): QueryBuilder<TRecordFor<T>> {
    return this.newQuery().whereNull(field)
  }

  static whereNotNull<T extends typeof Model>(
    this: T,
    field: keyof TRecordFor<T> & string,
  ): QueryBuilder<TRecordFor<T>> {
    return this.newQuery().whereNotNull(field)
  }

  static whereIn<T extends typeof Model>(
    this: T,
    field: keyof TRecordFor<T> & string,
    values: readonly TRecordFor<T>[keyof TRecordFor<T> & string][],
  ): QueryBuilder<TRecordFor<T>> {
    return this.newQuery().whereIn(field, values)
  }

  static whereNotIn<T extends typeof Model>(
    this: T,
    field: keyof TRecordFor<T> & string,
    values: readonly TRecordFor<T>[keyof TRecordFor<T> & string][],
  ): QueryBuilder<TRecordFor<T>> {
    return this.newQuery().whereNotIn(field, values)
  }

  static select<T extends typeof Model, Keys extends keyof TRecordFor<T> & string>(
    this: T,
    ...fields: readonly Keys[]
  ): QueryBuilder<TRecordFor<T>, Pick<TRecordFor<T>, Keys>> {
    return this.newQuery().select(...fields)
  }

  static newQuery<T extends typeof Model>(this: T, queryOptions?: ModelQueryOptions): QueryBuilder<TRecordFor<T>> {
    const builder = new QueryBuilder<TRecordFor<T>>(this, queryOptions)
    if (this.defaultScope) {
      this.defaultScope(builder)
    }
    const registry = this.globalScopeRegistry
    if (registry && registry.size > 0) {
      registry.apply(builder)
    }
    return builder
  }

  /** No scopes applied — for soft-deleted records or bypassing global filters. */
  static newQueryWithoutScopes<T extends typeof Model>(this: T, queryOptions?: ModelQueryOptions): QueryBuilder<TRecordFor<T>> {
    return new QueryBuilder<TRecordFor<T>>(this, queryOptions)
  }

  /**
   * Whether this model carries a filter every query must apply. Checked by the
   * entry points that talk to the adapter directly, to decide whether they can
   * take the fast path.
   */
  protected static hasScopes(): boolean {
    return Boolean(this.defaultScope) || Boolean(this.globalScopeRegistry && this.globalScopeRegistry.size > 0)
  }

  /** Apply a scope defined in `static scopes`; chainable. */
  static scope<T extends typeof Model>(this: T, name: string): QueryBuilder<TRecordFor<T>> {
    const scopes = this.scopes
    if (!scopes || typeof scopes[name] !== 'function') {
      throw new Error(`${this.name}: unknown scope "${name}".`)
    }
    const builder = this.newQuery()
    return scopes[name](builder) as QueryBuilder<TRecordFor<T>>
  }

  /**
   * One-to-many: `foreignKey` is on the related model, `localKey` on this one.
   * Declare in a `static {}` block; `name` is what `with()` takes.
   */
  static hasMany<
    This extends typeof Model,
    Related extends typeof Model,
    ForeignKey extends keyof TRecordFor<Related> & string,
    LocalKey extends keyof TRecordFor<This> & string,
    Name extends RelationKeyOrString<This>,
  >(
    this: This,
    name: Name,
    related: Related | (() => Related | Promise<Related>),
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

  /**
   * Many-to-one inverse: `foreignKey` is on *this* model, `ownerKey` on the
   * related one.
   */
  static belongsTo<
    This extends typeof Model,
    Related extends typeof Model,
    ForeignKey extends keyof TRecordFor<This> & string,
    OwnerKey extends keyof TRecordFor<Related> & string,
    Name extends RelationKeyOrString<This>,
  >(
    this: This,
    name: Name,
    related: Related | (() => Related | Promise<Related>),
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

  /**
   * One-to-one: `foreignKey` is on the related model, `localKey` on this one.
   */
  static hasOne<
    This extends typeof Model,
    Related extends typeof Model,
    ForeignKey extends keyof TRecordFor<Related> & string,
    LocalKey extends keyof TRecordFor<This> & string,
    Name extends RelationKeyOrString<This>,
  >(
    this: This,
    name: Name,
    related: Related | (() => Related | Promise<Related>),
    foreignKey: ForeignKey,
    localKey: LocalKey,
  ): void {
    const definitions = this.getRelationDefinitions()
    definitions.set(name, {
      type: 'hasOne',
      name,
      related,
      foreignKey,
      localKey,
    })
  }

  /**
   * Many-to-many through a pivot table. `foreignPivotKey`/`relatedPivotKey` are
   * both columns *on the pivot*, referencing this model and the related one;
   * `parentKey`/`relatedKey` are the local keys they point at.
   *
   * @example
   * this.belongsToMany('roles', Role, userRoles, 'userId', 'roleId', 'id', 'id')
   */
  static belongsToMany<
    This extends typeof Model,
    Related extends typeof Model,
    Name extends RelationKeyOrString<This>,
  >(
    this: This,
    name: Name,
    related: Related | (() => Related | Promise<Related>),
    pivotTable: unknown,
    foreignPivotKey: string,
    relatedPivotKey: string,
    parentKey?: string,
    relatedKey?: string,
  ): void {
    const definitions = this.getRelationDefinitions()
    definitions.set(name, {
      type: 'belongsToMany',
      name,
      related,
      pivotTable,
      foreignPivotKey,
      relatedPivotKey,
      parentKey: parentKey ?? 'id',
      relatedKey: relatedKey ?? 'id',
    })
  }

  /**
   * Has-many-through: `firstKey` is on the intermediate model referencing this
   * one, `secondKey` on the related model referencing the intermediate;
   * `localKey` and `secondLocalKey` are the keys they point at.
   *
   * @example
   * this.hasManyThrough('posts', Post, User, 'countryId', 'userId', 'id', 'id')
   */
  static hasManyThrough<
    This extends typeof Model,
    Related extends typeof Model,
    Through extends typeof Model,
    Name extends RelationKeyOrString<This>,
  >(
    this: This,
    name: Name,
    related: Related | (() => Related | Promise<Related>),
    through: Through | (() => Through | Promise<Through>),
    firstKey: string,
    secondKey: string,
    localKey?: string,
    secondLocalKey?: string,
  ): void {
    const definitions = this.getRelationDefinitions()
    definitions.set(name, {
      type: 'hasManyThrough',
      name,
      related,
      through,
      firstKey,
      secondKey,
      localKey: localKey ?? 'id',
      secondLocalKey: secondLocalKey ?? 'id',
    })
  }

  /** Type strings to model classes, e.g. `Model.morphMap = { Post, Video }`. */
  static morphMap?: Record<string, typeof Model>

  /**
   * Polymorphic one-to-many. `morphName` is the base of the column pair:
   * 'commentable' means commentableType + commentableId.
   */
  static morphMany<
    This extends typeof Model,
    Related extends typeof Model,
    Name extends RelationKeyOrString<This>,
  >(
    this: This,
    name: Name,
    related: Related | (() => Related | Promise<Related>),
    morphName: string,
    localKey?: string,
  ): void {
    this.getRelationDefinitions().set(name, {
      type: 'morphMany',
      name,
      related,
      morphName,
      localKey: localKey ?? 'id',
    })
  }

  /** Inverse of a polymorphic relation; `morphName` bases the type/id columns. */
  static morphTo<
    This extends typeof Model,
    Name extends RelationKeyOrString<This>,
  >(
    this: This,
    name: Name,
    morphName: string,
  ): void {
    this.getRelationDefinitions().set(name, {
      type: 'morphTo',
      name,
      related: undefined,
      morphName,
    })
  }

  /**
   * @example
   * await User.orderBy('createdAt')
   * await User.orderBy([['lastName', 'asc'], ['firstName', 'asc']], { status: 'active' })
   */
  static async orderBy<T extends typeof Model>(
    this: T,
    order: OrderByInput<TRecordFor<T>>,
    where?: WhereClauseFor<T>,
    queryOptions?: ModelQueryOptions,
  ): Promise<TRecordFor<T>[]> {
    const orderBy = normalizeOrderBy(order)

    if (this.hasScopes()) {
      const builder = this.newQuery(queryOptions)
      if (where && Object.keys(where).length > 0) {
        builder.where(where as Partial<Record<string, unknown>>)
      }
      for (const clause of orderBy) {
        builder.orderBy(clause.column as keyof TRecordFor<T> & string, clause.direction)
      }
      return builder.get()
    }

    const table = this.resolveTable()
    const options: FindManyOptions<TRecordFor<T>> = { orderBy }

    if (where && Object.keys(where).length > 0) {
      options.where = where
    }

    return this.getAdapter().findMany(table, options, queryOptions) as Promise<TRecordFor<T>[]>
  }

  /**
   * @example
   * await User.paginate({ page: 2, perPage: 20, where: { status: 'active' } })
   */
  static async paginate<T extends typeof Model>(
    this: T,
    options: PaginateOptions<TRecordFor<T>> = {},
    queryOptions?: ModelQueryOptions,
  ): Promise<PaginatedResult<TRecordFor<T>>> {
    // The count matters as much as the rows: an unscoped `meta.total` reports
    // how many records the filter was meant to hide.
    if (this.hasScopes()) {
      const builder = this.newQuery(queryOptions)
      if (options.where && Object.keys(options.where).length > 0) {
        builder.where(options.where as Partial<Record<string, unknown>>)
      }
      if (options.orderBy) {
        for (const clause of normalizeOrderBy(options.orderBy)) {
          builder.orderBy(clause.column as keyof TRecordFor<T> & string, clause.direction)
        }
      }
      return builder.paginate({ page: options.page, perPage: options.perPage })
    }

    const table = this.resolveTable()
    const adapter = this.getAdapter()

    const requestedPage = typeof options.page === 'number' ? options.page : 1
    const sanitizedPage = Number.isFinite(requestedPage) && requestedPage >= 1 ? Math.floor(requestedPage) : 1

    const requestedPerPage = typeof options.perPage === 'number' ? options.perPage : DEFAULT_PAGINATION_SIZE
    const perPage = Number.isFinite(requestedPerPage) && requestedPerPage >= 1 ? Math.floor(requestedPerPage) : DEFAULT_PAGINATION_SIZE

    let total = 0
    if (typeof adapter.count === 'function') {
      total = await adapter.count(table, options.where as WhereClauseFor<T>, queryOptions)
    } else {
      const records = options.where
        ? await this.newQuery(queryOptions).where(options.where as Partial<Record<string, unknown>>).get()
        : await this.all(queryOptions)
      total = records.length
    }

    const totalPages = total === 0 ? 1 : Math.max(1, Math.ceil(total / perPage))
    const currentPage = Math.min(sanitizedPage, totalPages)
    const offset = (currentPage - 1) * perPage

    const orderByClause = options.orderBy ? normalizeOrderBy(options.orderBy) : undefined
    const findOptions: FindManyOptions<TRecordFor<T>> = {
      where: options.where as WhereClauseFor<T> | undefined,
      orderBy: orderByClause,
      limit: perPage,
      offset,
    }

    const data = await adapter.findMany(table, findOptions, queryOptions) as Array<TRecordFor<T>>

    const from = total === 0 ? 0 : offset + 1
    const to = total === 0 ? 0 : offset + data.length

    const meta: ModelPaginationMeta = {
      total,
      perPage,
      currentPage,
      totalPages,
      hasMore: currentPage < totalPages,
      from,
      to: Math.min(to, total),
    }

    return { data, meta }
  }

  static async withPaginate<T extends typeof Model, K extends RelationPath<T>>(
    this: T,
    relations: K | readonly K[],
    options?: PaginateOptions<TRecordFor<T>>,
    queryOptions?: ModelQueryOptions,
  ): Promise<PaginatedResult<TRecordFor<T> & RelationTypePick<T, K | readonly K[]>>>

  static async withPaginate<T extends typeof Model, Names extends RelationNames>(
    this: T,
    relations: Names,
    options: PaginateOptions<TRecordFor<T>> = {},
    queryOptions?: ModelQueryOptions,
  ): Promise<PaginatedResult<TRecordFor<T> & RelationTypePick<T, Names>>> {
    const result = await this.paginate(options, queryOptions)
    const relationList = normalizeRelations(relations)

    if (relationList.length === 0 || result.data.length === 0) {
      return result as PaginatedResult<TRecordFor<T> & RelationTypePick<T, Names>>
    }

    const records = result.data.map((record) => ({ ...record }))

    await this.loadRelationsInto(records, relationList, queryOptions)

    return {
      data: records as Array<TRecordFor<T> & RelationTypePick<T, Names>>,
      meta: result.meta,
    }
  }

  static async create<T extends typeof Model>(
    this: T,
    data: TCreateFor<T>,
    writeOptions?: ModelWriteOptions,
  ): Promise<TRecordFor<T>> {
    return this.runCreate(data, writeOptions, true)
  }

  /**
   * Create bypassing mass-assignment protection. Trusted server-side data only
   * (OAuth linking, seeders, system records), never raw request input.
   */
  static async forceCreate<T extends typeof Model>(
    this: T,
    data: TCreateFor<T>,
    writeOptions?: ModelWriteOptions,
  ): Promise<TRecordFor<T>> {
    return this.runCreate(data, writeOptions, false)
  }

  protected static async runCreate<T extends typeof Model>(
    this: T,
    data: TCreateFor<T>,
    writeOptions: ModelWriteOptions | undefined,
    applyFillable: boolean,
  ): Promise<TRecordFor<T>> {
    const table = this.resolveTable()
    const filtered = applyFillable ? this.filterFillable(data) : { ...(data as PlainObject) }
    const payload = await this.preparePersistencePayload(filtered)

    const hooks = this.hooks
    const observers = this.observers
    if (hooks) {
      if (!(await executeHook(hooks, 'creating', payload))) {
        throw new Error(`${this.name}.create() aborted by 'creating' hook.`)
      }
      if (!(await executeHook(hooks, 'saving', payload))) {
        throw new Error(`${this.name}.create() aborted by 'saving' hook.`)
      }
    }
    if (observers) {
      if (!(await executeObservers(observers, 'creating', payload))) {
        throw new Error(`${this.name}.create() aborted by observer 'creating'.`)
      }
      if (!(await executeObservers(observers, 'saving', payload))) {
        throw new Error(`${this.name}.create() aborted by observer 'saving'.`)
      }
    }

    const result = await this.getAdapter().create(table, payload, writeOptions) as TRecordFor<T>

    if (hooks) {
      const resultData = result as unknown as Record<string, unknown>
      await executeHook(hooks, 'created', resultData)
      await executeHook(hooks, 'saved', resultData)
    }

    if (observers) {
      const resultData = result as unknown as Record<string, unknown>
      await executeObservers(observers, 'created', resultData)
      await executeObservers(observers, 'saved', resultData)
    }

    if (this.casts || this.accessors) {
      return this.applyReadTransforms(result)
    }
    return result
  }

  static async update<T extends typeof Model>(
    this: T,
    where: WhereClauseFor<T>,
    data: Partial<TCreateFor<T>>,
    writeOptions?: ModelWriteOptions,
  ): Promise<TRecordFor<T>> {
    return this.runUpdate(where, data, writeOptions, true)
  }

  /**
   * Update bypassing mass-assignment protection. Trusted server-side data only,
   * never raw request input.
   */
  static async forceUpdate<T extends typeof Model>(
    this: T,
    where: WhereClauseFor<T>,
    data: Partial<TCreateFor<T>>,
    writeOptions?: ModelWriteOptions,
  ): Promise<TRecordFor<T>> {
    return this.runUpdate(where, data, writeOptions, false)
  }

  protected static async runUpdate<T extends typeof Model>(
    this: T,
    where: WhereClauseFor<T>,
    data: Partial<TCreateFor<T>>,
    writeOptions: ModelWriteOptions | undefined,
    applyFillable: boolean,
  ): Promise<TRecordFor<T>> {
    const table = this.resolveTable()
    const adapter = this.getAdapter()
    if (!adapter.update) {
      throw new Error('Configured adapter does not support update operations.')
    }

    const filtered = applyFillable ? this.filterFillable(data) : { ...(data as PlainObject) }
    const payload = await this.preparePersistencePayload(filtered)

    const hooks = this.hooks
    const observers = this.observers
    if (hooks) {
      if (!(await executeHook(hooks, 'updating', payload))) {
        throw new Error(`${this.name}.update() aborted by 'updating' hook.`)
      }
      if (!(await executeHook(hooks, 'saving', payload))) {
        throw new Error(`${this.name}.update() aborted by 'saving' hook.`)
      }
    }
    if (observers) {
      if (!(await executeObservers(observers, 'updating', payload))) {
        throw new Error(`${this.name}.update() aborted by observer 'updating'.`)
      }
      if (!(await executeObservers(observers, 'saving', payload))) {
        throw new Error(`${this.name}.update() aborted by observer 'saving'.`)
      }
    }

    // Global scopes must reach writes: a tenant scope applied to reads but
    // dropped here lets one tenant update another's rows. The payload is
    // already prepared, so mutators/casts run once.
    const result = this.hasScopes()
      ? await this.newQuery(writeOptions)
          .where(where as Partial<Record<string, unknown>>)
          [PREPARED_UPDATE](payload) as TRecordFor<T>
      : await adapter.update(table, where, payload, writeOptions) as TRecordFor<T>

    if (hooks) {
      const resultData = result as unknown as Record<string, unknown>
      await executeHook(hooks, 'updated', resultData)
      await executeHook(hooks, 'saved', resultData)
    }

    if (observers) {
      const resultData = result as unknown as Record<string, unknown>
      await executeObservers(observers, 'updated', resultData)
      await executeObservers(observers, 'saved', resultData)
    }

    if (this.casts || this.accessors) {
      return this.applyReadTransforms(result)
    }
    return result
  }

  static async delete<T extends typeof Model>(
    this: T,
    where: WhereClauseFor<T>,
    writeOptions?: ModelWriteOptions,
  ): Promise<number | PlainObject | void> {
    const table = this.resolveTable()
    const adapter = this.getAdapter()
    if (!adapter.delete) {
      throw new Error('Configured adapter does not support delete operations.')
    }

    const hooks = this.hooks
    const observers = this.observers
    const whereData = where as unknown as Record<string, unknown>
    if (hooks) {
      if (!(await executeHook(hooks, 'deleting', whereData))) {
        throw new Error(`${this.name}.delete() aborted by 'deleting' hook.`)
      }
    }
    if (observers) {
      if (!(await executeObservers(observers, 'deleting', whereData))) {
        throw new Error(`${this.name}.delete() aborted by observer 'deleting'.`)
      }
    }

    // Same reasoning as runUpdate: a delete that skips the tenant scope lets
    // one tenant delete another's rows even though reads are isolated.
    const result = this.hasScopes()
      ? await this.newQuery(writeOptions)
          .where(where as Partial<Record<string, unknown>>)
          .delete()
      : await adapter.delete(table, where, writeOptions)

    if (hooks) {
      await executeHook(hooks, 'deleted', whereData)
    }
    if (observers) {
      await executeObservers(observers, 'deleted', whereData)
    }

    return result
  }

  /**
   * A raw Drizzle builder starting at `select().from(table)`. Carries no model
   * scopes, casts or accessors.
   */
  static query<TDatabase extends { select: (...args: any[]) => any } = { select: (...args: any[]) => any }>( // eslint-disable-line @typescript-eslint/no-explicit-any
    this: typeof Model,
    db?: TDatabase,
  ): SelectFrom<TDatabase> {
    const table = this.resolveTable()
    if (db) {
      const selectBuilder = db.select()
      if (!selectBuilder || typeof selectBuilder.from !== 'function') {
        throw new Error('Configured ORM adapter does not expose select().from; pass a Drizzle database to Model.query(db).')
      }
      return selectBuilder.from(table) as SelectFrom<TDatabase>
    }

    const resolvedDb = resolveQueryableDatabase(this.getAdapter())
    const fallbackBuilder = resolvedDb.select()

    if (!fallbackBuilder || typeof fallbackBuilder.from !== 'function') {
      throw new Error('Configured ORM adapter does not expose select().from; pass a Drizzle database to Model.query(db).')
    }

    return fallbackBuilder.from(table) as SelectFrom<TDatabase>
  }

  /**
   * Eager-load relations, one name or several, nested via dot notation.
   *
   * @example
   * await User.with(['posts.comments', 'profile'], { status: 'active' })
   */
  static async with<T extends typeof Model, K extends RelationPath<T>>(
    this: T,
    relations: K | readonly K[],
    where?: WhereClauseFor<T>,
    queryOptions?: ModelQueryOptions,
  ): Promise<Array<TRecordFor<T> & RelationTypePick<T, K | readonly K[]>>>

  static async with<T extends typeof Model, Names extends RelationNames>(
    this: T,
    relations: Names,
    where?: WhereClauseFor<T>,
    queryOptions?: ModelQueryOptions,
  ): Promise<Array<TRecordFor<T> & RelationTypePick<T, Names>>> {
    const records = where
      ? await this.newQuery(queryOptions).where(where as Partial<Record<string, unknown>>).get()
      : await this.all(queryOptions)
    if (!records.length) {
      return records as Array<TRecordFor<T> & RelationTypePick<T, Names>>
    }

    const relationList = normalizeRelations(relations)
    if (relationList.length === 0) {
      return records as Array<TRecordFor<T> & RelationTypePick<T, Names>>
    }

    const copies = records.map((record) => ({ ...record }))
    await this.loadRelationsInto(copies, relationList, queryOptions)

    return copies as Array<TRecordFor<T> & RelationTypePick<T, Names>>
  }

  /**
   * Attaches a `${name}Count` per record without loading the related rows.
   * belongsTo yields 0 or 1.
   */
  static async withCount<T extends typeof Model, K extends RelationKey<T>>(
    this: T,
    relations: K | readonly K[],
    where?: WhereClauseFor<T>,
    queryOptions?: ModelQueryOptions,
  ): Promise<Array<TRecordFor<T> & RelationCountPick<K | readonly K[]>>>

  static async withCount<T extends typeof Model, Names extends RelationNames>(
    this: T,
    relations: Names,
    where?: WhereClauseFor<T>,
    queryOptions?: ModelQueryOptions,
  ): Promise<Array<TRecordFor<T> & RelationCountPick<Names>>> {
    const records = where
      ? await this.newQuery(queryOptions).where(where as Partial<Record<string, unknown>>).get()
      : await this.all(queryOptions)
    if (!records.length) {
      return records as Array<TRecordFor<T> & RelationCountPick<Names>>
    }

    const relationList = normalizeRelations(relations)
    const copies = records.map((record) => ({ ...record })) as Array<PlainObject>
    for (const relationName of relationList) {
      await this.loadRelationCountInto(copies, relationName, queryOptions)
    }

    return copies as Array<TRecordFor<T> & RelationCountPick<Names>>
  }

  /** @internal Attaches a `${name}Count` field for one relation. */
  protected static async loadRelationCountInto<T extends typeof Model>(
    this: T,
    records: Array<PlainObject>,
    relationName: string,
    queryOptions?: ModelQueryOptions,
  ): Promise<void> {
    if (relationName.includes('.')) {
      throw new Error(`${this.name}: withCount does not support nested relation "${relationName}".`)
    }

    const definition = this.getRelationDefinition(relationName)
    if (!definition) {
      throw new Error(`${this.name}: unknown relation "${relationName}".`)
    }

    const countField = `${relationName}Count`

    switch (definition.type) {
      case 'hasMany':
      case 'hasOne': {
        const related = await resolveModelReference(definition.related)
        const { foreignKey, localKey } = definition
        const values = Array.from(
          new Set(records.map((record) => record[localKey]).filter((value) => value != null)),
        )

        const counts = new Map<unknown, number>()
        if (values.length > 0) {
          const relatedRecords = (await related.newQuery(queryOptions).where({ [foreignKey]: values } as WhereClause)) as PlainObject[]
          for (const item of relatedRecords) {
            const key = item[foreignKey]
            counts.set(key, (counts.get(key) ?? 0) + 1)
          }
        }

        for (const record of records) {
          record[countField] = counts.get(record[localKey]) ?? 0
        }
        return
      }
      case 'morphMany': {
        const withRelation = records.map((record) => ({ ...record }))
        await this.loadRelationInto(withRelation, relationName, queryOptions)
        for (const [index, record] of records.entries()) {
          const value = withRelation[index]?.[relationName]
          record[countField] = Array.isArray(value) ? value.length : 0
        }
        return
      }
      case 'belongsTo': {
        const related = await resolveModelReference(definition.related)
        const { foreignKey, ownerKey } = definition
        const values = Array.from(
          new Set(records.map((record) => record[foreignKey]).filter((value) => value != null)),
        )

        const ownerKeys = new Set<unknown>()
        if (values.length > 0) {
          const owners = (await related.newQuery(queryOptions).where({ [ownerKey]: values } as WhereClause)) as PlainObject[]
          for (const owner of owners) {
            ownerKeys.add(owner[ownerKey])
          }
        }

        for (const record of records) {
          const key = record[foreignKey]
          record[countField] = key != null && ownerKeys.has(key) ? 1 : 0
        }
        return
      }
      default:
        throw new Error(
          `${this.name}: withCount does not support ${definition.type} relation "${relationName}".`,
        )
    }
  }

  /**
   * @internal Used by QueryBuilder for eager loading. Paths are grouped by head
   * segment so a shared relation loads once: the loaders assign fresh spread
   * copies, so a second pass over `posts` would replace the very rows the first
   * attached children to and only the last path would survive.
   */
  static async loadRelationsInto<T extends typeof Model>(
    this: T,
    records: Array<PlainObject>,
    relationNames: readonly string[],
    queryOptions?: ModelQueryOptions,
    constraints?: EagerLoadConstraints,
    pathPrefix = '',
  ): Promise<void> {
    if (relationNames.length === 0) return

    const groups = new Map<string, string[]>()
    for (const path of relationNames) {
      const [head, ...rest] = path.split('.')
      const tails = groups.get(head) ?? []
      groups.set(head, tails)

      // A bare path contributes no tail, so `posts` alongside `posts.comments`
      // loads `posts` once. A trailing dot does contribute one — an empty tail
      // — so `posts.` still reaches the unknown-relation throw.
      if (rest.length > 0) {
        const tail = rest.join('.')
        if (!tails.includes(tail)) {
          tails.push(tail)
        }
      }
    }

    for (const [head, tails] of groups) {
      await this.loadRelationLevel(records, head, tails, queryOptions, constraints, pathPrefix)
    }
  }

  /**
   * @internal Public because generated code reaches it; internal callers should
   * use {@link loadRelationsInto}.
   */
  static async loadRelationInto<T extends typeof Model>(
    this: T,
    records: Array<PlainObject>,
    relationName: string,
    queryOptions?: ModelQueryOptions,
    constraints?: EagerLoadConstraints,
    pathPrefix = '',
  ): Promise<void> {
    await this.loadRelationsInto(records, [relationName], queryOptions, constraints, pathPrefix)
  }

  /**
   * `constraints` are keyed by the full path of the level each constrains, so
   * `pathPrefix` accumulates the path walked so far: at `posts.comments` the
   * leaf looks itself up under that whole key, not under `comments`.
   */
  protected static async loadRelationLevel<T extends typeof Model>(
    this: T,
    records: Array<PlainObject>,
    head: string,
    tails: readonly string[],
    queryOptions?: ModelQueryOptions,
    constraints?: EagerLoadConstraints,
    pathPrefix = '',
  ): Promise<void> {
    const definition = this.getRelationDefinition(head)

    if (!definition) {
      throw new Error(`${this.name}: unknown relation "${head}".`)
    }

    // Keyed by full path, so a nested walk that re-loads an already-constrained
    // head reapplies the filter instead of replacing it with unfiltered rows.
    const currentPath = pathPrefix ? `${pathPrefix}.${head}` : head
    const constraint = constraints?.get(currentPath)

    switch (definition.type) {
      case 'hasMany':
        await this.loadHasMany(records, definition, queryOptions, constraint)
        break
      case 'hasOne':
        await this.loadHasOne(records, definition, queryOptions, constraint)
        break
      case 'belongsTo':
        await this.loadBelongsTo(records, definition, queryOptions, constraint)
        break
      case 'belongsToMany':
        await this.loadBelongsToMany(records, definition, queryOptions, constraint)
        break
      case 'hasManyThrough':
        await this.loadHasManyThrough(records, definition, queryOptions, constraint)
        break
      case 'morphMany':
        await this.loadMorphMany(records, definition, queryOptions, constraint)
        break
      case 'morphTo':
        await this.loadMorphTo(records, definition, queryOptions, constraint)
        break
    }

    if (tails.length === 0) {
      return
    }

    if (definition.type === 'morphTo') {
      throw new Error(
        `${this.name}: nested eager loading through morphTo relation "${head}" is not supported.`,
      )
    }

    // Collect the loaded child records (deduplicated — belongsTo parents can
    // share one child copy) and recurse on the related model class.
    const children: PlainObject[] = []
    const seen = new Set<PlainObject>()
    for (const record of records) {
      const value = record[head]
      const items = Array.isArray(value) ? value : value != null ? [value] : []
      for (const item of items) {
        if (item && typeof item === 'object' && !seen.has(item as PlainObject)) {
          seen.add(item as PlainObject)
          children.push(item as PlainObject)
        }
      }
    }

    if (children.length === 0) {
      return
    }

    const related = await resolveModelReference(definition.related)
    await related.loadRelationsInto(children, tails, queryOptions, constraints, currentPath)
  }

  protected static async loadHasMany(
    records: Array<PlainObject>,
    definition: HasManyRelationDefinition,
    queryOptions?: ModelQueryOptions,
    constraint?: EagerLoadConstraint,
  ): Promise<void> {
    const { foreignKey, localKey, name } = definition
    const related = await resolveModelReference(definition.related)
    await loadRelationData(records, name, related, localKey, foreignKey, true, queryOptions, constraint)
  }

  protected static async loadHasOne(
    records: Array<PlainObject>,
    definition: HasOneRelationDefinition,
    queryOptions?: ModelQueryOptions,
    constraint?: EagerLoadConstraint,
  ): Promise<void> {
    const { foreignKey, localKey, name } = definition
    const related = await resolveModelReference(definition.related)
    await loadRelationData(records, name, related, localKey, foreignKey, false, queryOptions, constraint)
  }

  protected static async loadBelongsTo(
    records: Array<PlainObject>,
    definition: BelongsToRelationDefinition,
    queryOptions?: ModelQueryOptions,
    constraint?: EagerLoadConstraint,
  ): Promise<void> {
    const { foreignKey, ownerKey, name } = definition
    const related = await resolveModelReference(definition.related)
    await loadRelationData(records, name, related, foreignKey, ownerKey, false, queryOptions, constraint)
  }

  protected static async loadBelongsToMany(
    records: Array<PlainObject>,
    definition: BelongsToManyRelationDefinition,
    queryOptions?: ModelQueryOptions,
    constraint?: EagerLoadConstraint,
  ): Promise<void> {
    const { pivotTable, foreignPivotKey, relatedPivotKey, parentKey, relatedKey, name } = definition
    const related = await resolveModelReference(definition.related)

    const parentValues = Array.from(
      new Set(records.map((r) => r[parentKey]).filter((v): v is unknown => v != null)),
    )

    if (parentValues.length === 0) {
      for (const record of records) {
        record[name] = []
      }
      return
    }

    const adapter = this.getAdapter()
    const pivotRows = await adapter.findMany<PlainObject>(pivotTable, {
      where: { [foreignPivotKey]: parentValues } as WhereClause,
    }, queryOptions)

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
      return
    }

    // The constraint filters the related rows, not the pivot lookup.
    const relatedRecords = await applyEagerConstraint(
      related.newQuery(queryOptions).where({ [relatedKey]: Array.from(allRelatedIds) } as WhereClause),
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
  }

  protected static async loadHasManyThrough(
    records: Array<PlainObject>,
    definition: HasManyThroughRelationDefinition,
    queryOptions?: ModelQueryOptions,
    constraint?: EagerLoadConstraint,
  ): Promise<void> {
    const { firstKey, secondKey, localKey, secondLocalKey, name } = definition
    const related = await resolveModelReference(definition.related)
    const through = await resolveModelReference(definition.through)

    const localValues = Array.from(
      new Set(records.map((r) => r[localKey]).filter((v): v is unknown => v != null)),
    )

    if (localValues.length === 0) {
      for (const record of records) {
        record[name] = []
      }
      return
    }

    const throughRecords = await through.newQuery(queryOptions).where({
      [firstKey]: localValues,
    } as WhereClause) as PlainObject[]

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
      return
    }

    // The constraint filters the related rows, not the intermediate lookup.
    const relatedRecords = await applyEagerConstraint(
      related.newQuery(queryOptions).where({ [secondKey]: Array.from(allThroughIds) } as WhereClause),
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
  }

  protected static async loadMorphMany(
    records: Array<PlainObject>,
    definition: MorphManyRelationDefinition,
    queryOptions?: ModelQueryOptions,
    constraint?: EagerLoadConstraint,
  ): Promise<void> {
    const { morphName, localKey, name } = definition
    const related = await resolveModelReference(definition.related)
    const typeColumn = `${morphName}Type`
    const idColumn = `${morphName}Id`
    const parentType = this.name

    const localValues = Array.from(
      new Set(records.map((r) => r[localKey]).filter((v): v is unknown => v != null)),
    )

    if (localValues.length === 0) {
      for (const record of records) record[name] = []
      return
    }

    const allRelated = await applyEagerConstraint(
      related.newQuery(queryOptions).where({ [typeColumn]: parentType, [idColumn]: localValues } as WhereClause),
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
  }

  protected static async loadMorphTo(
    records: Array<PlainObject>,
    definition: MorphToRelationDefinition,
    queryOptions?: ModelQueryOptions,
    constraint?: EagerLoadConstraint,
  ): Promise<void> {
    const { morphName, name } = definition
    const typeColumn = `${morphName}Type`
    const idColumn = `${morphName}Id`
    const morphMap = Model.morphMap ?? {}

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
      const results = await applyEagerConstraint(
        modelClass.newQuery(queryOptions).where({ id: uniqueIds } as WhereClause),
        constraint,
      )
      const idMap = new Map<unknown, PlainObject>()
      for (const r of results) idMap.set(r.id, { ...r })
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
}

/**
 * The callback runs with the foreign-key filter already on the builder, so a
 * `where()` narrows it and a top-level `orWhere()` widens it — a loader that
 * groups on something weaker than the full filter (morphMany, on the morph id)
 * must not rely on the query alone to keep other rows out.
 */
async function applyEagerConstraint(
  query: QueryBuilder,
  constraint?: EagerLoadConstraint,
): Promise<PlainObject[]> {
  constraint?.(query)
  return (await query) as PlainObject[]
}

async function loadRelationData(
  records: PlainObject[],
  name: string,
  related: typeof Model,
  parentKey: string,
  relatedKey: string,
  isArray: boolean,
  queryOptions?: ModelQueryOptions,
  constraint?: EagerLoadConstraint,
): Promise<void> {
  const values = Array.from(
    new Set(records.map((r) => r[parentKey]).filter((v): v is unknown => v != null)),
  )

  if (values.length === 0) {
    for (const record of records) {
      record[name] = isArray ? [] : null
    }
    return
  }

  const relatedRecords = await applyEagerConstraint(
    related.newQuery(queryOptions).where({ [relatedKey]: values } as WhereClause),
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
}

async function resolveModelReference(
  reference: typeof Model | (() => typeof Model | Promise<typeof Model>),
): Promise<typeof Model> {
  if (typeof reference === 'function' && 'prototype' in reference && reference.prototype instanceof Model) {
    return reference as typeof Model
  }

  return await (reference as () => typeof Model | Promise<typeof Model>)()
}

type TRecordFor<T extends typeof Model> = T extends { recordType: infer R }
  ? R extends PlainObject
    ? R
    : PlainObject
  : PlainObject

type TCreateFor<T extends typeof Model> = T extends { createType: infer R }
  ? R extends PlainObject
    ? R
    : PlainObject
  : PlainObject

type WhereClauseFor<T extends typeof Model> = WhereClause<TRecordFor<T>>
type FieldFor<T extends typeof Model> = keyof TRecordFor<T> & string

type RelationNames = string | readonly string[]

// Only the head segment is checked against relationTypes; the tail is an
// unvalidated string, so a typo'd or malformed nested segment type-checks.
// loadRelationLevel() throws for it at runtime, but only once it recurses into
// a loaded child row — if the head relation loads zero rows anywhere, the call
// silently no-ops.
type RelationPath<T extends typeof Model> = RelationKey<T> | `${RelationKey<T>}.${string}`

type RelationHead<Name> = Name extends `${infer Head}.${string}` ? Head : Name

type RelationTypesFor<T extends typeof Model> = T extends { relationTypes: infer R }
  ? R extends RelationShape
    ? R
    : {}
  : {}

type RelationKey<T extends typeof Model> = keyof RelationTypesFor<T> & string

type RelationKeyOrString<T extends typeof Model> = RelationKey<T> extends never ? string : RelationKey<T>

type RelationNameUnion<Names> = Names extends readonly (infer Items)[] ? Items : Names

// Note: a single non-distributing mapped type — `Keys extends string ? ...`
// would distribute over the union and turn with(['a', 'b']) results into
// `{ a } | { b }` instead of `{ a } & { b }`.
type RelationTypePick<T extends typeof Model, Names> = {
  [K in RelationHead<RelationNameUnion<Names>> & string & keyof RelationTypesFor<T>]: RelationTypesFor<T>[K]
}

type RelationCountPick<Names> = { [K in RelationNameUnion<Names> & string as `${K}Count`]: number }

export interface TransactionModelScope<T extends typeof Model> {
  readonly trx: TransactionHandle
  all(): Promise<TRecordFor<T>[]>
  find(id: unknown): Promise<TRecordFor<T> | null>
  findOrFail(id: unknown): Promise<TRecordFor<T>>
  first(where?: WhereClauseFor<T>): Promise<TRecordFor<T> | null>
  where(callback: WhereGroupCallback<TRecordFor<T>>): QueryBuilder<TRecordFor<T>>
  where(conditions: WhereClauseFor<T>): QueryBuilder<TRecordFor<T>>
  where(field: FieldFor<T>, value: unknown): QueryBuilder<TRecordFor<T>>
  where(field: FieldFor<T>, operator: WhereOperator, value: unknown): QueryBuilder<TRecordFor<T>>
  newQuery(): QueryBuilder<TRecordFor<T>>
  create(data: TCreateFor<T>): Promise<TRecordFor<T>>
  update(where: WhereClauseFor<T>, data: Partial<TCreateFor<T>>): Promise<TRecordFor<T>>
  delete(where: WhereClauseFor<T>): Promise<number | PlainObject | void>
  paginate(options?: PaginateOptions<TRecordFor<T>>): Promise<PaginatedResult<TRecordFor<T>>>
}

interface BaseRelationDefinition {
  type: 'hasMany' | 'hasOne' | 'belongsTo' | 'belongsToMany' | 'hasManyThrough' | 'morphMany' | 'morphTo'
  name: string
  related: typeof Model | (() => typeof Model | Promise<typeof Model>)
}

interface HasManyRelationDefinition extends BaseRelationDefinition {
  type: 'hasMany'
  foreignKey: string
  localKey: string
}

interface HasOneRelationDefinition extends BaseRelationDefinition {
  type: 'hasOne'
  foreignKey: string
  localKey: string
}

interface BelongsToRelationDefinition extends BaseRelationDefinition {
  type: 'belongsTo'
  foreignKey: string
  ownerKey: string
}

interface BelongsToManyRelationDefinition extends BaseRelationDefinition {
  type: 'belongsToMany'
  pivotTable: unknown
  foreignPivotKey: string
  relatedPivotKey: string
  parentKey: string
  relatedKey: string
}

interface HasManyThroughRelationDefinition extends BaseRelationDefinition {
  type: 'hasManyThrough'
  through: typeof Model | (() => typeof Model | Promise<typeof Model>)
  firstKey: string
  secondKey: string
  localKey: string
  secondLocalKey: string
}

type RelationDefinition =
  | HasManyRelationDefinition
  | HasOneRelationDefinition
  | BelongsToRelationDefinition
  | BelongsToManyRelationDefinition
  | HasManyThroughRelationDefinition
  | MorphManyRelationDefinition
  | MorphToRelationDefinition

interface MorphManyRelationDefinition extends BaseRelationDefinition {
  type: 'morphMany'
  morphName: string
  localKey: string
}

interface MorphToRelationDefinition {
  type: 'morphTo'
  name: string
  related: undefined
  morphName: string
}

export type HasManyRelationResult<T extends typeof Model> = Array<TRecordFor<T>>

export type BelongsToRelationResult<T extends typeof Model> = TRecordFor<T> | null

export type HasManyRecord<TRecord extends PlainObject> = TRecord[]

export type BelongsToRecord<TRecord extends PlainObject> = TRecord | null

/**
 * For a belongsTo backed by a NOT NULL foreign key, where the parent is
 * guaranteed once loaded.
 *
 * @example
 * declare static relationTypes: { author: BelongsToRequiredRecord<UserRecord> }
 */
export type BelongsToRequiredRecord<TRecord extends PlainObject> = TRecord

export type HasOneRelationResult<T extends typeof Model> = TRecordFor<T> | null

export type BelongsToManyRelationResult<T extends typeof Model> = Array<TRecordFor<T>>

export type HasManyThroughRelationResult<T extends typeof Model> = Array<TRecordFor<T>>

export type HasOneRecord<TRecord extends PlainObject> = TRecord | null

export type BelongsToManyRecord<TRecord extends PlainObject> = TRecord[]

export type HasManyThroughRecord<TRecord extends PlainObject> = TRecord[]

export type MorphManyRelationResult<T extends typeof Model> = Array<TRecordFor<T>>

export type MorphManyRecord<TRecord extends PlainObject> = TRecord[]

export type MorphToRelationResult = PlainObject | null

export type MorphToRecord = PlainObject | null

export type WithRelations<
  T extends typeof Model,
  K extends RelationPath<T> | readonly RelationPath<T>[],
> = TRecordFor<T> & RelationTypePick<T, K>

type ModelClassWithTable<TTable extends TableShape, TBase extends typeof Model, TCreate extends PlainObject> = TBase & {
  readonly table: TTable
  readonly recordType: InferModelRecord<TTable>
  readonly createType: TCreate
}

type CreateKey<TTable extends TableShape, TBase extends typeof Model> =
  | keyof InferModelInsert<TTable>
  | keyof TCreateFor<TBase>

/**
 * Named fields a base contributes to the create payload (`AuthenticatableModel`'s
 * virtual `password`). A plain `Model` base declares no createType, so its keys
 * collapse to `string` — guard that, or every misspelling passes the allowlists.
 */
type BaseContributedKey<TBase extends typeof Model> =
  string extends keyof TCreateFor<TBase> & string ? never : keyof TCreateFor<TBase> & string

type FillableKey<TTable extends TableShape, TBase extends typeof Model> =
  | (keyof InferModelInsert<TTable> & string)
  | BaseContributedKey<TBase>

type RecordKey<TTable extends TableShape> = keyof InferModelRecord<TTable> & string

/**
 * Homomorphic on purpose, so the key union is inferred from the object
 * literal's keys: the accessor functions are context-sensitive, which under a
 * plain `Record<string, fn>` defers inference past the key parameter's default.
 */
type AccessorsShape<TTable extends TableShape, TKey extends string> = {
  [K in TKey]: (record: InferModelRecord<TTable>) => unknown
}

type CreateShape<
  TTable extends TableShape,
  TBase extends typeof Model,
  TOptional extends keyof InferModelInsert<TTable>,
  TRequire extends CreateKey<TTable, TBase>,
> = Partial<Pick<InferModelInsert<TTable>, TOptional>> &
  Omit<InferModelInsert<TTable>, TOptional> &
  TCreateFor<TBase> &
  Required<Pick<InferModelInsert<TTable> & TCreateFor<TBase>, TRequire & keyof (InferModelInsert<TTable> & TCreateFor<TBase>)>>

/**
 * A table-backed model base class. `recordType`/`createType` are inferred from
 * the table; `optionalOnCreate`/`requireOnCreate` reshape the inferred create
 * payload without a cast, for a model like `AuthenticatableModel` that hashes a
 * virtual `password` into `passwordHash`. Passing the allowlist statics as
 * options rather than declaring them checks every name against the table's
 * columns, so a typo is a compile error rather than a dead entry; a `static` on
 * the subclass shadows the option, as normal class semantics.
 *
 * @example
 * class User extends defineModel(users, { fillable: ['name', 'email'] }) {}
 */
export function defineModel<
  TTable extends TableShape,
  TBase extends typeof Model = typeof Model,
  const TOptional extends keyof InferModelInsert<TTable> = never,
  const TRequire extends CreateKey<TTable, TBase> = never,
  TAccessorKey extends string = never,
>(
  table: TTable,
  options: {
    base?: TBase
    /** Type-level only: columns the model fills in itself. */
    optionalOnCreate?: readonly TOptional[]
    /**
     * Type-level only: fields to make required on the create payload. Accepts
     * table columns (Drizzle marks defaulted ones optional) and `base`-
     * contributed fields such as the virtual `password`.
     */
    requireOnCreate?: readonly TRequire[]
    /** Typed `static fillable`, checked against insertable and base fields. */
    fillable?: readonly FillableKey<TTable, TBase>[]
    /** Typed `static hidden`, checked against record columns and accessors. */
    hidden?: readonly (RecordKey<TTable> | NoInfer<TAccessorKey>)[]
    /** Typed `static visible`, checked against record columns and accessors. */
    visible?: readonly (RecordKey<TTable> | NoInfer<TAccessorKey>)[]
    /**
     * Typed `static accessors`; the names here are what `appends` may
     * reference. The Record intersection rejects non-object values — with no
     * keys to infer, the mapped type alone collapses to `{}`.
     */
    accessors?: AccessorsShape<TTable, TAccessorKey> &
      Record<string, (record: InferModelRecord<TTable>) => unknown>
    /** Typed `static appends`, checked against the names in `accessors`. */
    appends?: readonly NoInfer<TAccessorKey>[]
  } = {},
): ModelClassWithTable<TTable, TBase, CreateShape<TTable, TBase, TOptional, TRequire>> {
  type ResolvedCreate = CreateShape<TTable, TBase, TOptional, TRequire>

  const BaseClass = (options.base ?? Model) as typeof Model

  abstract class DefinedModel extends BaseClass {}

  ;(DefinedModel as typeof Model & { table: TTable }).table = table
  ;(DefinedModel as typeof Model & { recordType: InferModelRecord<TTable> }).recordType =
    {} as InferModelRecord<TTable>
  ;(DefinedModel as typeof Model & { createType: ResolvedCreate }).createType = {} as ResolvedCreate

  if (options.fillable) DefinedModel.fillable = [...options.fillable]
  if (options.hidden) DefinedModel.hidden = [...options.hidden]
  if (options.visible) DefinedModel.visible = [...options.visible]
  if (options.accessors) DefinedModel.accessors = options.accessors as unknown as AccessorDefinitions
  if (options.appends) DefinedModel.appends = [...options.appends]

  return DefinedModel as ModelClassWithTable<TTable, TBase, ResolvedCreate>
}

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

function hasDatabaseAccessor(adapter: ORMAdapter): adapter is ORMAdapter & { getDatabase: () => { select: (...args: any[]) => any } } { // eslint-disable-line @typescript-eslint/no-explicit-any
  return typeof (adapter as { getDatabase?: unknown }).getDatabase === 'function'
}

function resolveQueryableDatabase(adapter: ORMAdapter): { select: (...args: any[]) => any } { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (hasDatabaseAccessor(adapter)) {
    return adapter.getDatabase()
  }

  throw new Error('No queryable database found. Configure the ORM adapter or pass a Drizzle database to Model.query(db).')
}
