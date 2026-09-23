import { castInPlace } from './casts'
import type {
  RelationDefinition, HasManyRelationDefinition, HasOneRelationDefinition,
  BelongsToRelationDefinition, BelongsToManyRelationDefinition,
  HasManyThroughRelationDefinition, MorphManyRelationDefinition, MorphToRelationDefinition,
} from './relation-definitions'
import * as relationLoading from './relation-loading'
import { countByChunks, countOwnersPresent, distinctKeys, maxInListSize, relationCountPlan, resolveModelReference } from './relation-records'
import { groupRelationPaths, loadRelationChildren } from './relation-tree'
import { DrizzleAdapter } from './adapters/drizzle-adapter'
import { applyAccessors, applyMutators } from './attributes'
import type { AccessorDefinitions, MutatorDefinitions } from './attributes'
import { warnDeprecated } from './deprecate'
import { GlobalScopeRegistry } from './GlobalScopeRegistry'
import type { ScopeFunction } from './GlobalScopeRegistry'
import type { ModelHooks } from './hooks'
import { modelLifecycle } from './model-lifecycle'
import type { ModelObserver, ModelObserverConstructor } from './ModelObserver'
import { ModelNotFoundException } from './ModelNotFoundException'
import { everyFilterDropped } from './where-conditions'
import { LIFECYCLE_DELETE, PREPARED_UPDATE, RAW_RESULTS, READ_TRANSFORMS, SEAL_SCOPES } from './internal-keys'
import { QueryBuilder } from './QueryBuilder'
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
  /** Must not commit before the callback's promise settles: drizzle's bun-sqlite does. */
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
/** The options of `create(data, { set })` and `update(where, data, { set })` (RFC 0031). */
export type ModelSetOptions<T extends typeof Model, S extends SetFor<T>> = ModelWriteOptions & SetOption<T, S>
type SetWriteOptions = ModelWriteOptions & { set?: PlainObject }
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
// oxlint-disable-next-line no-unused-vars -- phantom type parameter, kept because it is part of the public signature
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
   * bugs and injection attempts surface. A column the server chooses goes in
   * `set`, and must stay out of this list. Independent of it, `id` is always
   * stripped and `deniedFields()` always throws.
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
      create: ((data: TCreateFor<T>, options?: SetWriteOptions) =>
        this.create(data, { ...options, trx })) as TransactionModelScope<T>['create'],
      update: ((where: WhereClauseFor<T>, data: Partial<TCreateFor<T>>, options?: SetWriteOptions) =>
        this.update(where, data, { ...options, trx })) as TransactionModelScope<T>['update'],
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
  static withoutGlobalScope<T extends typeof Model>(this: T, ...names: string[]): QueryBuilder<TRecordFor<T>>
  /**
   * Query options lead here because `names` is a rest parameter and cannot be
   * followed by an optional one; every other entry point takes them trailing.
   */
  static withoutGlobalScope<T extends typeof Model>(
    this: T,
    queryOptions: ModelQueryOptions,
    ...names: string[]
  ): QueryBuilder<TRecordFor<T>>
  static withoutGlobalScope<T extends typeof Model>(
    this: T,
    ...args: Array<string | ModelQueryOptions>
  ): QueryBuilder<TRecordFor<T>> {
    const [first, ...rest] = args
    if (typeof first === 'string' || first === undefined) {
      return this.buildScopedQuery(undefined, args as string[])
    }
    return this.buildScopedQuery(first, rest as string[])
  }

  /** A query with no global scopes applied, `defaultScope` included. */
  static withoutGlobalScopes<T extends typeof Model>(
    this: T,
    queryOptions?: ModelQueryOptions,
  ): QueryBuilder<TRecordFor<T>> {
    return new QueryBuilder<TRecordFor<T>>(this, queryOptions)
  }

  /**
   * Ahead of the `updating`/`deleting` hooks, which must not fire for a write
   * that is refused; the builder repeats the check for its own callers.
   */
  private static assertFiltersSurvived(where: unknown, operation: 'update' | 'delete'): void {
    if (!everyFilterDropped(where)) return
    throw new Error(
      `${this.name}: refusing to ${operation} unfiltered — every value in the where clause was undefined.`,
    )
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
    castInPlace(result, castDefs)
    return result
  }

  /** The one read-transform pass for a record, in order: casts then accessors. */
  protected static applyReadTransforms<T extends PlainObject>(record: T): T {
    if (!this.casts && !this.accessors) return record
    let result = record
    if (this.casts) result = this.applyCasts(result)
    if (this.accessors) result = applyAccessors(result, this.accessors)
    return result
  }

  /**
   * The same pass over a result set. Symbol-keyed for `QueryBuilder` across the
   * module boundary, and kept out of the package entry point. `projected` marks
   * a row `select()` narrowed: an accessor there would read columns that are not
   * on it, while `applyCasts` already skips an absent one.
   */
  static [READ_TRANSFORMS]<T extends PlainObject>(records: T[], projected = false): T[] {
    if (projected) {
      return this.casts ? records.map((record) => this.applyCasts(record)) : records
    }
    if (!this.casts && !this.accessors) return records
    return records.map((record) => this.applyReadTransforms(record))
  }

  /**
   * In order: a non-empty `set` is refused without `fillable`, or holding `id`,
   * a denied or a fillable key (RFC 0031); `deniedFields()` throws, checked on
   * the raw input so no later rule can swallow them; `id` is stripped silently;
   * then, with `fillable` set, anything outside it throws. `set` is merged last.
   */
  static filterFillable(data: PlainObject, set?: PlainObject): PlainObject {
    const fillableFields = this.fillable
    const deniedFields = this.deniedFields()
    const setKeys = set ? Object.keys(set) : []
    if (setKeys.length > 0) this.assertSettable(setKeys, fillableFields, deniedFields)

    const denied = deniedFields.filter((field) => field in data)
    if (denied.length > 0) {
      throw new MassAssignmentException(this.name, denied, { reason: 'denied' })
    }

    let candidate = data
    if ('id' in candidate) {
      const { id: _id, ...rest } = candidate
      candidate = rest
    }

    if (!fillableFields) {
      return candidate
    }

    const blocked = Object.keys(candidate).filter((key) => !fillableFields.includes(key))
    if (blocked.length > 0) {
      const alsoSet = blocked.filter((key) => setKeys.includes(key))
      throw alsoSet.length > 0
        ? new MassAssignmentException(this.name, alsoSet, { set: 'conflict' })
        : new MassAssignmentException(this.name, blocked)
    }

    const filtered: PlainObject = {}
    for (const key of fillableFields) {
      if (key in candidate) {
        filtered[key] = candidate[key]
      }
    }
    return setKeys.length > 0 ? { ...filtered, ...set } : filtered
  }

  private static assertSettable(keys: string[], fillableFields: string[] | undefined, deniedFields: string[]): void {
    if (!fillableFields) {
      throw new MassAssignmentException(this.name, keys, { set: 'no-fillable' })
    }
    if (keys.includes('id')) {
      throw new MassAssignmentException(this.name, ['id'], { set: 'id' })
    }
    const denied = keys.filter((key) => deniedFields.includes(key))
    if (denied.length > 0) {
      throw new MassAssignmentException(this.name, denied, { reason: 'denied' })
    }
    const fillable = keys.filter((key) => fillableFields.includes(key))
    if (fillable.length > 0) {
      throw new MassAssignmentException(this.name, fillable, { set: 'fillable' })
    }
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
    return this.newQuery(queryOptions).get()
  }

  /**
   * The rows a relation load joins against, as the adapter read them: a cast on
   * the parent's key column would stop the child rows from matching it.
   */
  protected static async rawRecords<T extends typeof Model>(
    this: T,
    where: WhereClauseFor<T> | undefined,
    queryOptions?: ModelQueryOptions,
  ): Promise<Array<TRecordFor<T>>> {
    return this.newQuery(queryOptions).where((where ?? {}) as Partial<Record<string, unknown>>)[RAW_RESULTS]()
  }

  static async find<T extends typeof Model>(
    this: T,
    id: TRecordFor<T>[keyof TRecordFor<T> & string],
    key: keyof TRecordFor<T> & string = 'id' as keyof TRecordFor<T> & string,
    queryOptions?: ModelQueryOptions,
  ): Promise<TRecordFor<T> | null> {
    // An undefined identifier renders no WHERE clause at all, so `find` would
    // return an arbitrary row. `null` is left alone: it renders `IS NULL`.
    if (id === undefined) {
      return null
    }
    if (this.hasScopes()) {
      return this.newQuery(queryOptions).where(key, id as TRecordFor<T>[typeof key]).first()
    }
    const table = this.resolveTable()
    const where = { [key]: id } as WhereClauseFor<T>
    const record = await this.getAdapter().findUnique(table, where, queryOptions) as TRecordFor<T> | null
    return record && this.applyReadTransforms(record)
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
    // Same contract as find(); the scoped arm below never reaches
    // QueryBuilder.first(), which carries this rule for builder chains.
    if (everyFilterDropped(where)) {
      return null
    }
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
    return record && this.applyReadTransforms(record)
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
    return this.buildScopedQuery(queryOptions)
  }

  /**
   * The one place a scoped builder is born: applying scopes without sealing
   * them leaves them foldable by a later `orWhere()`, and nothing else would
   * report it. `except` names the global scopes to leave off.
   */
  private static buildScopedQuery<T extends typeof Model>(
    this: T,
    queryOptions?: ModelQueryOptions,
    except?: string[],
  ): QueryBuilder<TRecordFor<T>> {
    const builder = new QueryBuilder<TRecordFor<T>>(this, queryOptions)
    if (this.defaultScope) {
      this.defaultScope(builder)
    }
    const registry = this.globalScopeRegistry
    if (registry && registry.size > 0) {
      registry.apply(builder, except)
    }
    return builder[SEAL_SCOPES]()
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

    const records = await this.getAdapter().findMany(table, options, queryOptions) as TRecordFor<T>[]
    return this[READ_TRANSFORMS](records)
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
    return this.paginationQuery(options, queryOptions).paginate({ page: options.page, perPage: options.perPage })
  }

  /**
   * The builder owns pagination: the count matters as much as the rows, and a
   * second sanitise-count-slice here would agree with the builder's by
   * inspection rather than by construction.
   */
  private static paginationQuery<T extends typeof Model>(
    this: T,
    options: PaginateOptions<TRecordFor<T>>,
    queryOptions?: ModelQueryOptions,
  ): QueryBuilder<TRecordFor<T>> {
    const builder = this.newQuery(queryOptions)
    if (options.where && Object.keys(options.where).length > 0) {
      builder.where(options.where as Partial<Record<string, unknown>>)
    }
    if (options.orderBy) {
      for (const clause of normalizeOrderBy(options.orderBy)) {
        builder.orderBy(clause.column as keyof TRecordFor<T> & string, clause.direction)
      }
    }
    return builder
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
    const builder = this.paginationQuery(options, queryOptions)
    const relationList = normalizeRelations(relations)
    if (relationList.length > 0) {
      builder.with(...relationList)
    }

    return builder.paginate({ page: options.page, perPage: options.perPage }) as Promise<
      PaginatedResult<TRecordFor<T> & RelationTypePick<T, Names>>
    >
  }

  /**
   * `set` holds the columns the server chose, such as an owner. They skip
   * `fillable`, must not be in it, and `data` is filtered as without `set`.
   *
   * @example
   * await Post.create(data, { set: { authorId: user.id } })
   */
  static create<T extends typeof Model, S extends SetFor<T>>(
    this: T,
    data: CreateDataFor<T, NoInfer<S>>,
    options: ModelSetOptions<T, S>,
  ): Promise<TRecordFor<T>>
  // Last, so `.call`/`.bind`/`Parameters<>`, which read the last overload, see the signature they always did.
  static create<T extends typeof Model>(this: T, data: TCreateFor<T>, writeOptions?: ModelWriteOptions): Promise<TRecordFor<T>>
  static async create<T extends typeof Model>(
    this: T,
    data: TCreateFor<T>,
    options?: SetWriteOptions,
  ): Promise<TRecordFor<T>> {
    if (!options || !('set' in options)) return this.runCreate(data, options, true)
    const { set, ...writeOptions } = options
    return this.runCreate(data, writeOptions, true, set)
  }

  /**
   * Create bypassing mass-assignment protection. Data that carries nothing from
   * the request only (OAuth linking, seeders, system records); a server-chosen
   * column next to request data goes in `create(data, { set })`.
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
    set?: PlainObject,
  ): Promise<TRecordFor<T>> {
    const table = this.resolveTable()
    const filtered = applyFillable ? this.filterFillable(data, set) : { ...(data as PlainObject) }
    const payload = await this.preparePersistencePayload(filtered)

    const lifecycle = modelLifecycle(this.name, 'create', this.hooks, this.observers)
    await lifecycle.before(payload)

    const result = await this.getAdapter().create(table, payload, writeOptions) as TRecordFor<T>

    await lifecycle.after(result as unknown as Record<string, unknown>)

    return this.applyReadTransforms(result)
  }

  /** `set` as in `create(data, { set })`. */
  static update<T extends typeof Model, S extends SetFor<T>>(
    this: T,
    where: WhereClauseFor<T>,
    data: Partial<CreateDataFor<T, NoInfer<S>>>,
    options: ModelSetOptions<T, S>,
  ): Promise<TRecordFor<T>>
  static update<T extends typeof Model>(
    this: T,
    where: WhereClauseFor<T>,
    data: Partial<TCreateFor<T>>,
    writeOptions?: ModelWriteOptions,
  ): Promise<TRecordFor<T>>
  static async update<T extends typeof Model>(
    this: T,
    where: WhereClauseFor<T>,
    data: Partial<TCreateFor<T>>,
    options?: SetWriteOptions,
  ): Promise<TRecordFor<T>> {
    if (!options || !('set' in options)) return this.runUpdate(where, data, options, true)
    const { set, ...writeOptions } = options
    return this.runUpdate(where, data, writeOptions, true, set)
  }

  /**
   * Update bypassing mass-assignment protection. Data that carries nothing from
   * the request only; a server-chosen column next to request data goes in
   * `update(where, data, { set })`.
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
    set?: PlainObject,
  ): Promise<TRecordFor<T>> {
    const adapter = this.getAdapter()
    if (!adapter.update) {
      throw new Error('Configured adapter does not support update operations.')
    }
    this.assertFiltersSurvived(where, 'update')

    const filtered = applyFillable ? this.filterFillable(data, set) : { ...(data as PlainObject) }
    const payload = await this.preparePersistencePayload(filtered)

    const lifecycle = modelLifecycle(this.name, 'update', this.hooks, this.observers)
    await lifecycle.before(payload)

    const result = await this.newQuery(writeOptions)
      .where(where as Partial<Record<string, unknown>>)
      [PREPARED_UPDATE](payload) as TRecordFor<T>

    await lifecycle.after(result as unknown as Record<string, unknown>)

    return this.applyReadTransforms(result)
  }

  static async delete<T extends typeof Model>(
    this: T,
    where: WhereClauseFor<T>,
    writeOptions?: ModelWriteOptions,
  ): Promise<number | PlainObject | void> {
    const adapter = this.getAdapter()
    if (!adapter.delete) {
      throw new Error('Configured adapter does not support delete operations.')
    }

    return this[LIFECYCLE_DELETE](where, 'delete', () => this.newQuery(writeOptions)
      .where(where as Partial<Record<string, unknown>>)
      .delete())
  }

  /**
   * Runs `write` between the `deleting` and `deleted` events, for `delete()`
   * and the SoftDeletes overrides. Symbol-keyed and kept out of the package
   * entry point; each caller checks its own adapter capability first.
   */
  static async [LIFECYCLE_DELETE](
    this: typeof Model,
    where: object,
    method: string,
    write: () => Promise<number | PlainObject | void>,
  ): Promise<number | PlainObject | void> {
    this.assertFiltersSurvived(where, 'delete')

    const lifecycle = modelLifecycle(this.name, 'delete', this.hooks, this.observers, method)
    const whereData = where as Record<string, unknown>
    await lifecycle.before(whereData)

    const result = await write()

    await lifecycle.after(whereData)

    return result
  }

  /**
   * A raw Drizzle builder starting at `select().from(table)`. Carries no model
   * scopes, casts or accessors.
   *
   * @deprecated Reads soft-deleted rows and other tenants' rows. Use `Model.newQuery().toDrizzle()`
   * (or `toDrizzle(db.select().from(table))`), which keeps the scopes, or the builder's `sum`/`avg`/`min`/`max`/`exists`.
   */
  static query<TDatabase extends { select: (...args: any[]) => any } = { select: (...args: any[]) => any }>( // eslint-disable-line @typescript-eslint/no-explicit-any
    this: typeof Model,
    db?: TDatabase,
  ): SelectFrom<TDatabase> {
    warnDeprecated(
      'model-query-raw',
      `${this.name}.query`,
      'It skips every global scope, SoftDeletes included. Use newQuery().toDrizzle(), or toDrizzle(query) for joins.',
      { since: '2.11.0', removedIn: '3.0.0' },
    )
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
    const records = await this.rawRecords(where, queryOptions)
    const relationList = normalizeRelations(relations)
    if (records.length === 0 || relationList.length === 0) {
      return this[READ_TRANSFORMS](records) as Array<TRecordFor<T> & RelationTypePick<T, Names>>
    }

    await this.loadRelationsInto(records, relationList, queryOptions)

    return this[READ_TRANSFORMS](records) as Array<TRecordFor<T> & RelationTypePick<T, Names>>
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
    const records = await this.rawRecords(where, queryOptions)
    if (records.length === 0) {
      return this[READ_TRANSFORMS](records) as Array<TRecordFor<T> & RelationCountPick<Names>>
    }

    const relationList = normalizeRelations(relations)
    for (const relationName of relationList) {
      await this.loadRelationCountInto(records as Array<PlainObject>, relationName, queryOptions)
    }

    return this[READ_TRANSFORMS](records) as Array<TRecordFor<T> & RelationCountPick<Names>>
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

    const plan = relationCountPlan(definition, this.name)
    if (!plan) {
      throw new Error(
        `${this.name}: withCount does not support ${definition.type} relation "${relationName}".`,
      )
    }

    const related = await resolveModelReference(plan.related)
    const keys = distinctKeys(records, plan.parentKey)
    const size = maxInListSize(related.getAdapter())

    const counts = plan.presenceOnly
      ? await countOwnersPresent(related, plan.childKey, keys, size, queryOptions)
      : await countByChunks(keys, size, (chunk) => related
          .newQuery(queryOptions)
          .where({ ...plan.where, [plan.childKey]: chunk } as WhereClause)
          .countBy(plan.childKey))

    const countField = `${relationName}Count`
    for (const record of records) {
      record[countField] = counts.get(record[plan.parentKey]) ?? 0
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

    for (const [head, tails] of groupRelationPaths(relationNames)) {
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

    // A constraint's `select()` narrows the child rows, so the related model's
    // accessors are skipped there for the reason `QueryBuilder.select()` skips
    // them. Only the loader's own query can report it.
    let projected = false

    switch (definition.type) {
      case 'hasMany':
        projected = await this.loadHasMany(records, definition, queryOptions, constraint)
        break
      case 'hasOne':
        projected = await this.loadHasOne(records, definition, queryOptions, constraint)
        break
      case 'belongsTo':
        projected = await this.loadBelongsTo(records, definition, queryOptions, constraint)
        break
      case 'belongsToMany':
        projected = await this.loadBelongsToMany(records, definition, queryOptions, constraint)
        break
      case 'hasManyThrough':
        projected = await this.loadHasManyThrough(records, definition, queryOptions, constraint)
        break
      case 'morphMany':
        projected = await this.loadMorphMany(records, definition, queryOptions, constraint)
        break
      case 'morphTo':
        await this.loadMorphTo(records, definition, queryOptions, constraint)
        break
    }

    await loadRelationChildren({
      modelName: this.name, records, definition, head, tails, projected, currentPath, queryOptions, constraints,
    })
  }

  protected static async loadHasMany(
    records: Array<PlainObject>,
    definition: HasManyRelationDefinition,
    queryOptions?: ModelQueryOptions,
    constraint?: EagerLoadConstraint,
  ): Promise<boolean> {
    return relationLoading.loadHasMany(records, definition, queryOptions, constraint)
  }

  protected static async loadHasOne(
    records: Array<PlainObject>,
    definition: HasOneRelationDefinition,
    queryOptions?: ModelQueryOptions,
    constraint?: EagerLoadConstraint,
  ): Promise<boolean> {
    return relationLoading.loadHasOne(records, definition, queryOptions, constraint)
  }

  protected static async loadBelongsTo(
    records: Array<PlainObject>,
    definition: BelongsToRelationDefinition,
    queryOptions?: ModelQueryOptions,
    constraint?: EagerLoadConstraint,
  ): Promise<boolean> {
    return relationLoading.loadBelongsTo(records, definition, queryOptions, constraint)
  }

  protected static async loadBelongsToMany(
    records: Array<PlainObject>,
    definition: BelongsToManyRelationDefinition,
    queryOptions?: ModelQueryOptions,
    constraint?: EagerLoadConstraint,
  ): Promise<boolean> {
    return relationLoading.loadBelongsToMany(this, records, definition, queryOptions, constraint)
  }

  protected static async loadHasManyThrough(
    records: Array<PlainObject>,
    definition: HasManyThroughRelationDefinition,
    queryOptions?: ModelQueryOptions,
    constraint?: EagerLoadConstraint,
  ): Promise<boolean> {
    return relationLoading.loadHasManyThrough(records, definition, queryOptions, constraint)
  }

  protected static async loadMorphMany(
    records: Array<PlainObject>,
    definition: MorphManyRelationDefinition,
    queryOptions?: ModelQueryOptions,
    constraint?: EagerLoadConstraint,
  ): Promise<boolean> {
    return relationLoading.loadMorphMany(this, records, definition, queryOptions, constraint)
  }

  protected static async loadMorphTo(
    records: Array<PlainObject>,
    definition: MorphToRelationDefinition,
    queryOptions?: ModelQueryOptions,
    constraint?: EagerLoadConstraint,
  ): Promise<void> {
    return relationLoading.loadMorphTo(Model.morphMap ?? {}, records, definition, queryOptions, constraint)
  }
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

// defineModel's create type carries an index signature (a plain Model base adds
// PlainObject), which `Omit` would collapse the named columns into.
type OmitNamed<T, K extends PropertyKey> = { [P in keyof T as P extends K ? never : P]: T[P] }
type NamedKeys<T> = keyof { [P in keyof T as string extends P ? never : number extends P ? never : P]: T[P] }

type SetFor<T extends typeof Model> = OmitNamed<Partial<TCreateFor<T>>, 'id'>

// `S` is inferred from the `set` literal, and an inferred type parameter gets no
// excess-property check: the `never` keys are what reject `id` and a misspelt
// column. A model whose create type names no key accepts any.
type SetOption<T extends typeof Model, S> = {
  set: S & { [K in Exclude<keyof S, SettableKey<T>>]: never }
}
type SettableKey<T extends typeof Model> = [NamedKeys<SetFor<T>>] extends [never] ? PropertyKey : NamedKeys<SetFor<T>>

type CreateDataFor<T extends typeof Model, S> = OmitNamed<TCreateFor<T>, keyof S> & { [K in keyof S]?: never }

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
  create<S extends SetFor<T>>(data: CreateDataFor<T, NoInfer<S>>, options: SetOption<T, S>): Promise<TRecordFor<T>>
  create(data: TCreateFor<T>): Promise<TRecordFor<T>>
  update<S extends SetFor<T>>(
    where: WhereClauseFor<T>,
    data: Partial<CreateDataFor<T, NoInfer<S>>>,
    options: SetOption<T, S>,
  ): Promise<TRecordFor<T>>
  update(where: WhereClauseFor<T>, data: Partial<TCreateFor<T>>): Promise<TRecordFor<T>>
  delete(where: WhereClauseFor<T>): Promise<number | PlainObject | void>
  paginate(options?: PaginateOptions<TRecordFor<T>>): Promise<PaginatedResult<TRecordFor<T>>>
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
 * A table-backed model base class: `recordType`/`createType` inferred from the
 * table, `optionalOnCreate`/`requireOnCreate` reshaping the create payload without
 * a cast (`AuthenticatableModel` hashes a virtual `password` into `passwordHash`).
 * Allowlist statics passed as options are checked against the table's columns, so
 * a typo is a compile error; a `static` on the subclass shadows the option.
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
