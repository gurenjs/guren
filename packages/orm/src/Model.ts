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
import type { WhereGroupCallback, WhereOperator } from './QueryBuilder'
import { serializeRecord, serializeRecords } from './serialization'
import { MassAssignmentException } from './MassAssignmentException'

/** Generic plain object type used throughout the ORM. */
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

/** Supported cast types for attribute casting. */
export type CastType = 'json' | 'date' | 'boolean' | 'number' | 'string'

/**
 * Value type for where clause conditions.
 * Supports single values, arrays (for IN queries), or null.
 */
export type WhereValue<Value> = Value | readonly Value[] | null

/**
 * Where clause for filtering records.
 * Supports equality and IN (array) queries.
 *
 * @example
 * // Single value (equality)
 * { status: 'active' }
 *
 * // Array value (IN query)
 * { id: [1, 2, 3] }
 *
 * // Multiple conditions (AND)
 * { status: 'active', role: 'admin' }
 */
export type WhereClause<TRecord extends PlainObject = PlainObject> = Partial<{
  [K in keyof TRecord & string]?: WhereValue<TRecord[K]>
}>

/** Sort direction for ordering queries. */
export type OrderDirection = 'asc' | 'desc'

/** Normalized order definition with column and direction. */
export type OrderDefinition<TRecord extends PlainObject = PlainObject> = {
  column: keyof TRecord & string
  direction: OrderDirection
}

/**
 * Flexible order expression input.
 * @example
 * 'createdAt'                        // Column name (ascending)
 * ['createdAt', 'desc']              // Tuple [column, direction]
 * { column: 'createdAt', direction: 'desc' }  // Object form
 */
export type OrderExpression<TRecord extends PlainObject = PlainObject> =
  | (keyof TRecord & string)
  | readonly [keyof TRecord & string, OrderDirection]
  | { column: keyof TRecord & string; direction?: OrderDirection }

/** Input for orderBy - single expression or array of expressions. */
export type OrderByInput<TRecord extends PlainObject = PlainObject> =
  | OrderExpression<TRecord>
  | readonly OrderExpression<TRecord>[]

/** Normalized array of order definitions. */
export type OrderByClause<TRecord extends PlainObject = PlainObject> = readonly OrderDefinition<TRecord>[]

/** Options for findMany queries. */
export interface FindManyOptions<TRecord extends PlainObject = PlainObject> {
  /** Filter conditions */
  where?: WhereClause<TRecord>
  /** Sort order */
  orderBy?: OrderByClause<TRecord>
  /** Maximum number of records to return */
  limit?: number
  /** Number of records to skip */
  offset?: number
}

/** Options for paginated queries. */
export interface PaginateOptions<TRecord extends PlainObject = PlainObject> {
  /** Page number (1-based, default: 1) */
  page?: number
  /** Records per page (default: 15) */
  perPage?: number
  /** Filter conditions */
  where?: WhereClause<TRecord>
  /** Sort order */
  orderBy?: OrderByInput<TRecord>
}

/** Pagination metadata returned with paginated results. */
export interface ModelPaginationMeta {
  /** Total number of records matching the query */
  total: number
  /** Number of records per page */
  perPage: number
  /** Current page number (1-based) */
  currentPage: number
  /** Total number of pages */
  totalPages: number
  /** Whether there are more pages after this one */
  hasMore: boolean
  /** Index of first record on this page (1-based) */
  from: number
  /** Index of last record on this page */
  to: number
}

/** Result of a paginated query. */
export interface PaginatedResult<TRecord extends PlainObject = PlainObject> {
  /** Records for the current page */
  data: TRecord[]
  /** Pagination metadata */
  meta: ModelPaginationMeta
}

/**
 * Interface for ORM adapters that power the Model class.
 * The default adapter is DrizzleAdapter.
 */
export interface ORMAdapter {
  /** Run operations in a database transaction. */
  transaction?<TResult>(callback: (trx: unknown) => Promise<TResult>): Promise<TResult>
  /** Find multiple records with optional filtering, ordering, and pagination. */
  findMany<TRecord extends PlainObject = PlainObject>(
    table: unknown,
    options?: FindManyOptions<TRecord>,
    queryOptions?: AdapterQueryOptions,
  ): Promise<TRecord[]>
  /** Find a single record by unique criteria. */
  findUnique<TRecord extends PlainObject = PlainObject>(
    table: unknown,
    where: WhereClause<TRecord>,
    queryOptions?: AdapterQueryOptions,
  ): Promise<TRecord | null>
  /** Create a new record. */
  create<TRecord extends PlainObject = PlainObject>(
    table: unknown,
    data: PlainObject,
    writeOptions?: AdapterQueryOptions,
  ): Promise<TRecord>
  /** Update records matching criteria. */
  update?<TRecord extends PlainObject = PlainObject>(
    table: unknown,
    where: WhereClause<TRecord>,
    data: PlainObject,
    writeOptions?: AdapterQueryOptions,
  ): Promise<TRecord>
  /** Delete records matching criteria. */
  delete?<TRecord extends PlainObject = PlainObject>(
    table: unknown,
    where: WhereClause<TRecord>,
    writeOptions?: AdapterQueryOptions,
  ): Promise<number | PlainObject | void>
  /** Count records matching criteria. */
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
 * ActiveRecord-style base class for database models.
 *
 * Provides a Laravel Eloquent-like API for database operations including
 * CRUD, querying, pagination, and eager-loading of relationships.
 *
 * @example
 * // Define a model — recordType/createType are inferred from the Drizzle table
 * class User extends defineModel(users) {}
 *
 * // Or, when extending Model directly, redeclare the type markers
 * class LegacyUser extends Model<UserRecord> {
 *   static override table = users  // Drizzle table
 *   declare static readonly recordType: UserRecord
 *   declare static readonly createType: NewUserRecord
 * }
 *
 * // Query records
 * const allUsers = await User.all()
 * const user = await User.find(1)
 * const activeUsers = await User.where({ status: 'active' })
 *
 * // Create and update
 * const newUser = await User.create({ name: 'John', email: 'john@example.com' })
 * await User.update({ id: 1 }, { name: 'Jane' })
 *
 * // Pagination
 * const page = await User.paginate({ page: 1, perPage: 10 })
 *
 * // Relationships
 * const usersWithPosts = await User.with('posts')
 */
export abstract class Model<TRecord extends PlainObject = PlainObject> {
  /** The ORM adapter used for database operations. */
  protected static ormAdapter: ORMAdapter = DrizzleAdapter
  /** The database table (e.g., Drizzle table schema). */
  protected static table: unknown
  /** Type marker for TypeScript inference. Set by `defineModel()`; when extending `Model` directly, redeclare as `declare static readonly recordType: YourRecordType`. */
  static readonly recordType: unknown = undefined as unknown
  /** Type marker for insert/update payload inference. Set by `defineModel()`; when extending `Model` directly, redeclare as `declare static readonly createType: YourCreateType`. */
  static readonly createType: unknown = undefined as unknown
  protected static relationDefinitions?: Map<string, RelationDefinition>
  /** Type marker for relation types. Define relation types here for type inference. */
  static relationTypes: RelationShape = {}

  /**
   * Named query scopes for reusable query constraints.
   *
   * @example
   * class Post extends Model<PostRecord> {
   *   static scopes = {
   *     published: (q: QueryBuilder<PostRecord>) => q.where('status', 'published'),
   *     popular: (q: QueryBuilder<PostRecord>) => q.where('views', '>', 1000),
   *   }
   * }
   * // Usage: Post.scope('published').scope('popular').get()
   */
  static scopes?: Record<string, (q: QueryBuilder<any>) => QueryBuilder<any>> // eslint-disable-line @typescript-eslint/no-explicit-any

  /**
   * Default scope applied to all queries on this model.
   * Override this to automatically filter queries (e.g., soft deletes).
   *
   * @example
   * static defaultScope = (q: QueryBuilder<any>) => q.whereNull('deletedAt')
   */
  static defaultScope?: (q: QueryBuilder<any>) => QueryBuilder<any> // eslint-disable-line @typescript-eslint/no-explicit-any

  /**
   * Model lifecycle hooks that fire during create, update, and delete operations.
   *
   * @example
   * class User extends Model<UserRecord> {
   *   static hooks: ModelHooks = {
   *     creating: async (data) => { data.password = await hash(data.password as string) },
   *     created: async (data) => { console.log('User created:', data) },
   *   }
   * }
   */
  static hooks?: ModelHooks

  /**
   * Attribute casting definitions for automatic type conversion.
   *
   * Casts are applied when reading records from the database and when
   * writing records to the database.
   *
   * @example
   * class Post extends Model<PostRecord> {
   *   static casts = {
   *     metadata: 'json',
   *     publishedAt: 'date',
   *     isActive: 'boolean',
   *     viewCount: 'number',
   *   }
   * }
   */
  static casts?: Record<string, CastType>

  /**
   * Whitelist of fields allowed for mass assignment.
   * If set, `create()` and `update()` accept only these fields — input
   * containing any other key throws a MassAssignmentException so bugs
   * (and injection attempts) surface immediately instead of being
   * silently discarded. Use `forceCreate()` / `forceUpdate()` for
   * trusted server-side data.
   *
   * The primary key (`id`) is always silently stripped from mass-assignment
   * input, and fields returned by `deniedFields()` always throw — neither
   * depends on `fillable`.
   *
   * @example
   * class User extends Model<UserRecord> {
   *   static fillable = ['name', 'email', 'password']
   * }
   */
  static fillable?: string[]

  /**
   * Fields that can never be mass-assigned, resolved at call time so
   * subclasses can derive them from their own configuration (e.g.
   * `AuthenticatableModel` contributes its resolved password-hash and
   * remember-token columns). Input containing any of these throws a
   * MassAssignmentException regardless of `fillable` — use
   * `forceCreate()` / `forceUpdate()` for trusted server-side values.
   */
  protected static deniedFields(): string[] {
    return []
  }

  /**
   * Accessor functions for computed/virtual attributes.
   * Applied after reading records from the database.
   *
   * @example
   * class User extends Model<UserRecord> {
   *   static accessors = {
   *     fullName: (record) => `${record.firstName} ${record.lastName}`,
   *   }
   * }
   */
  static accessors?: AccessorDefinitions

  /**
   * Mutator functions for transforming attributes before persistence.
   *
   * @example
   * class User extends Model<UserRecord> {
   *   static mutators = {
   *     email: (value) => String(value).toLowerCase(),
   *   }
   * }
   */
  static mutators?: MutatorDefinitions

  /**
   * Fields to exclude from serialization output.
   *
   * @example
   * class User extends Model<UserRecord> {
   *   static hidden = ['passwordHash', 'rememberToken']
   * }
   */
  static hidden?: string[]

  /**
   * Whitelist of fields to include in serialization output.
   * When set, only these fields appear. Takes precedence over `hidden`.
   */
  static visible?: string[]

  /**
   * Virtual accessor attributes to include in serialization output.
   *
   * @example
   * class User extends Model<UserRecord> {
   *   static appends = ['fullName']
   *   static accessors = { fullName: (r) => `${r.firstName} ${r.lastName}` }
   * }
   */
  static appends?: string[]

  /** Registered model observers. */
  protected static observers?: ModelObserver[]

  /** Named global scopes registry. */
  protected static globalScopeRegistry?: GlobalScopeRegistry

  /**
   * Set a custom ORM adapter for this model.
   * @param adapter - The adapter to use
   */
  static useAdapter(adapter: ORMAdapter): void {
    this.ormAdapter = adapter
  }

  /**
   * Get the current ORM adapter.
   * @returns The configured adapter
   */
  static getAdapter(): ORMAdapter {
    return this.ormAdapter
  }

  /**
   * Run operations inside a database transaction.
   *
   * @example
   * await User.transaction(async (trx) => {
   *   const user = await User.create({ name: 'John' }, { trx })
   *   await Profile.create({ userId: user.id }, { trx })
   * })
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

  /**
   * Create a transaction-bound model scope that automatically forwards `trx`
   * to query and write operations.
   *
   * @example
   * await User.transaction(async (trx, txUser) => {
   *   await txUser.create({ name: 'Shinji' })
   *   await txUser.update({ id: 1 }, { name: 'Ikari' })
   * })
   */
  static inTransaction<T extends typeof Model>(this: T, trx: TransactionHandle): TransactionModelScope<T> {
    const where: TransactionModelScope<T>['where'] = (
      fieldOrConditions: FieldFor<T> | WhereClauseFor<T>,
      operatorOrValue?: unknown,
      value?: unknown,
    ) => {
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

  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // Observers
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------

  /**
   * Register a model observer class.
   *
   * @example
   * User.observe(UserObserver)
   */
  static observe(ObserverClass: ModelObserverConstructor): void {
    if (!Object.prototype.hasOwnProperty.call(this, 'observers') || !this.observers) {
      this.observers = []
    }
    this.observers.push(new ObserverClass())
  }

  /** Clear all registered observers. */
  static clearObservers(): void {
    this.observers = []
  }

  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // Global Scopes
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------

  /**
   * The registry this class may mutate, creating it on first write.
   *
   * The new registry is seeded from the inherited one: the read paths
   * (`newQuery()`, `hasScopes()`) resolve `globalScopeRegistry` through the
   * prototype chain, so a subclass that started from an empty registry would
   * shadow — and silently drop — every scope it inherited. That is exactly the
   * `class Post extends SoftDeletes(Base)` then `Post.addGlobalScope('tenant')`
   * case, which would otherwise lose the `softDelete` filter.
   *
   * The copy is a snapshot: scopes added to the parent *after* a subclass first
   * registers or removes one do not reach that subclass. Nothing in the
   * framework relies on later propagation — the `SoftDeletes` mixin registers
   * `softDelete` synchronously while building the class, before any user code
   * can touch it.
   */
  protected static getGlobalScopes(): GlobalScopeRegistry {
    if (!Object.prototype.hasOwnProperty.call(this, 'globalScopeRegistry') || !this.globalScopeRegistry) {
      const inherited = this.globalScopeRegistry
      this.globalScopeRegistry = inherited ? inherited.clone() : new GlobalScopeRegistry()
    }
    return this.globalScopeRegistry
  }

  /**
   * Register a named global scope.
   *
   * @example
   * User.addGlobalScope('active', (q) => q.where('active', true))
   */
  static addGlobalScope(name: string, fn: ScopeFunction): void {
    this.getGlobalScopes().add(name, fn)
  }

  /** Remove a named global scope. */
  static removeGlobalScope(name: string): void {
    this.getGlobalScopes().remove(name)
  }

  /**
   * Start a query excluding specific global scope(s).
   *
   * Only *named* scopes can be excluded: `defaultScope` is re-applied here
   * whatever this is asked to drop. A mixin whose filter users must be able to
   * opt out of therefore has to register a named scope and nothing else —
   * registering as both makes the filter unremovable, which is how `SoftDeletes`
   * once made `withoutGlobalScope('softDelete')` a no-op.
   *
   * @example
   * const all = await User.withoutGlobalScope('active').get()
   */
  static withoutGlobalScope<T extends typeof Model>(this: T, ...names: string[]): QueryBuilder<TRecordFor<T>> {
    const builder = new QueryBuilder<TRecordFor<T>>(this)
    // Apply defaultScope if present
    if (this.defaultScope) {
      this.defaultScope(builder)
    }
    // Apply global scopes except the excluded ones
    this.getGlobalScopes().apply(builder, names)
    return builder
  }

  /**
   * Start a query with no global scopes applied (also skips defaultScope).
   *
   * @example
   * const all = await User.withoutGlobalScopes().get()
   */
  static withoutGlobalScopes<T extends typeof Model>(this: T): QueryBuilder<TRecordFor<T>> {
    return new QueryBuilder<TRecordFor<T>>(this)
  }

  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // Serialization
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------

  /**
   * Serialize a record for API/JSON output.
   * Applies hidden/visible filtering, accessors, and appends.
   *
   * @example
   * const json = User.serialize(user)
   */
  static serialize<T extends typeof Model>(this: T, record: TRecordFor<T>): PlainObject {
    return serializeRecord(record, {
      hidden: this.hidden,
      visible: this.visible,
      appends: this.appends,
      accessors: this.accessors,
    })
  }

  /**
   * Serialize an array of records.
   *
   * @example
   * const json = User.serializeMany(users)
   */
  static serializeMany<T extends typeof Model>(this: T, records: TRecordFor<T>[]): PlainObject[] {
    return serializeRecords(records, {
      hidden: this.hidden,
      visible: this.visible,
      appends: this.appends,
      accessors: this.accessors,
    })
  }

  /**
   * Apply attribute casts to a record read from the database.
   *
   * @param record - The raw record from the database
   * @returns The record with cast attributes applied
   */
  static applyCasts<T extends PlainObject>(record: T): T {
    const castDefs = this.casts
    if (!castDefs) return record

    // Only copy if at least one castable field exists in the record
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
              // Keep original value if parsing fails
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

  /**
   * Apply all read-time transforms: casts then accessors.
   * Used internally after fetching records from the database.
   */
  protected static applyReadTransforms<T extends PlainObject>(record: T): T {
    let result = record
    if (this.casts) result = this.applyCasts(result)
    if (this.accessors) result = applyAccessors(result, this.accessors)
    return result
  }

  /**
   * Filter input data based on mass assignment protection rules.
   *
   * Applied in order: fields returned by `deniedFields()` throw a
   * MassAssignmentException (checked on the raw input, so no other rule
   * can silently swallow them); the primary key (`id`) is silently
   * stripped; when `fillable` is defined, any remaining field outside it
   * throws and only listed fields are kept.
   *
   * @param data - The input data to filter
   * @returns Filtered data safe for mass assignment
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

    // Apply mutators before persistence
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

  /**
   * Retrieve all records from the table.
   *
   * @returns Array of all records
   *
   * @example
   * const users = await User.all()
   */
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

  /**
   * Find a record by its primary key.
   *
   * @param id - The primary key value
   * @param key - The primary key column name (default: 'id')
   * @returns The record or null if not found
   *
   * @example
   * const user = await User.find(1)
   * const userByEmail = await User.find('john@example.com', 'email')
   */
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

  /**
   * Find a record by primary key or throw an error.
   *
   * @param id - The primary key value
   * @param key - The primary key column name (default: 'id')
   * @returns The record
   * @throws Error if record not found
   *
   * @example
   * const user = await User.findOrFail(1) // Throws if not found
   */
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

  /**
   * Find a record by primary key with eager-loaded relations.
   *
   * @param id - The primary key value
   * @param relations - Relation name(s) to eager load
   * @param key - The primary key column name (default: 'id')
   * @returns The record with loaded relations, or null if not found
   *
   * @example
   * const post = await Post.findWith(1, 'author')
   * const post = await Post.findWith(1, ['author', 'tags'])
   */
  static async findWith<T extends typeof Model, K extends RelationPath<T>>(
    this: T,
    id: TRecordFor<T>[keyof TRecordFor<T> & string],
    relations: K | readonly K[],
    key?: keyof TRecordFor<T> & string,
  ): Promise<(TRecordFor<T> & RelationTypePick<T, K | readonly K[]>) | null>

  static async findWith<T extends typeof Model, Names extends RelationNames>(
    this: T,
    id: TRecordFor<T>[keyof TRecordFor<T> & string],
    relations: Names,
    key?: keyof TRecordFor<T> & string,
  ): Promise<(TRecordFor<T> & RelationTypePick<T, Names>) | null> {
    const record = await this.find(id, key)
    if (record == null) return null

    const relationList = normalizeRelations(relations)
    if (relationList.length === 0) {
      return record as TRecordFor<T> & RelationTypePick<T, Names>
    }

    const copy = { ...record }
    for (const rel of relationList) {
      await this.loadRelationInto([copy], rel)
    }
    return copy as TRecordFor<T> & RelationTypePick<T, Names>
  }

  /**
   * Find a record by primary key with eager-loaded relations, or throw.
   *
   * @param id - The primary key value
   * @param relations - Relation name(s) to eager load
   * @param key - The primary key column name (default: 'id')
   * @returns The record with loaded relations
   * @throws ModelNotFoundException if record not found
   *
   * @example
   * const post = await Post.findWithOrFail(1, 'author')
   * const post = await Post.findWithOrFail(1, ['author', 'tags'])
   * const post = await Post.findWithOrFail(1, 'comments.author') // nested
   */
  static async findWithOrFail<T extends typeof Model, K extends RelationPath<T>>(
    this: T,
    id: TRecordFor<T>[keyof TRecordFor<T> & string],
    relations: K | readonly K[],
    key?: keyof TRecordFor<T> & string,
  ): Promise<TRecordFor<T> & RelationTypePick<T, K | readonly K[]>>

  static async findWithOrFail<T extends typeof Model, Names extends RelationNames>(
    this: T,
    id: TRecordFor<T>[keyof TRecordFor<T> & string],
    relations: Names,
    key?: keyof TRecordFor<T> & string,
  ): Promise<TRecordFor<T> & RelationTypePick<T, Names>> {
    const record = await this.findOrFail(id, key)

    const relationList = normalizeRelations(relations)
    if (relationList.length === 0) {
      return record as TRecordFor<T> & RelationTypePick<T, Names>
    }

    const copy = { ...record }
    for (const rel of relationList) {
      await this.loadRelationInto([copy], rel)
    }
    return copy as TRecordFor<T> & RelationTypePick<T, Names>
  }

  /**
   * Get the first record matching the conditions.
   *
   * @param where - Optional filter conditions
   * @returns The first matching record or null
   *
   * @example
   * const admin = await User.first({ role: 'admin' })
   */
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
   * Start a fluent query with where conditions.
   *
   * Returns a QueryBuilder that is thenable, so it can be directly awaited.
   *
   * @example
   * // Object form - multiple equality conditions
   * const activeUsers = await User.where({ status: 'active' })
   *
   * // Field + value - equality
   * const admins = await User.where('role', 'admin')
   *
   * // Field + operator + value - comparison
   * const recent = await Post.where('views', '>', 100)
   *
   * // Fluent chaining
   * const posts = await Post.where('status', 'published')
   *   .where('views', '>', 100)
   *   .orderBy('createdAt', 'desc')
   *   .limit(10)
   *   .get()
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

  /**
   * Start a fluent query with a WHERE NULL condition.
   * @param field - Column to check for NULL
   */
  static whereNull<T extends typeof Model>(
    this: T,
    field: keyof TRecordFor<T> & string,
  ): QueryBuilder<TRecordFor<T>> {
    return this.newQuery().whereNull(field)
  }

  /**
   * Start a fluent query with a WHERE NOT NULL condition.
   * @param field - Column to check for NOT NULL
   */
  static whereNotNull<T extends typeof Model>(
    this: T,
    field: keyof TRecordFor<T> & string,
  ): QueryBuilder<TRecordFor<T>> {
    return this.newQuery().whereNotNull(field)
  }

  /**
   * Start a fluent query with a WHERE IN condition.
   * @param field - Column to check
   * @param values - Array of values to match against
   */
  static whereIn<T extends typeof Model>(
    this: T,
    field: keyof TRecordFor<T> & string,
    values: readonly TRecordFor<T>[keyof TRecordFor<T> & string][],
  ): QueryBuilder<TRecordFor<T>> {
    return this.newQuery().whereIn(field, values)
  }

  /**
   * Start a fluent query with a WHERE NOT IN condition.
   * @param field - Column to check
   * @param values - Array of values to exclude
   */
  static whereNotIn<T extends typeof Model>(
    this: T,
    field: keyof TRecordFor<T> & string,
    values: readonly TRecordFor<T>[keyof TRecordFor<T> & string][],
  ): QueryBuilder<TRecordFor<T>> {
    return this.newQuery().whereNotIn(field, values)
  }

  /**
   * Start a fluent query with a typed field selection.
   *
   * @example
   * const rows = await User.select('id', 'name')
   * const first = await User.select('id').first()
   */
  static select<T extends typeof Model, Keys extends keyof TRecordFor<T> & string>(
    this: T,
    ...fields: readonly Keys[]
  ): QueryBuilder<TRecordFor<T>, Pick<TRecordFor<T>, Keys>> {
    return this.newQuery().select(...fields)
  }

  /**
   * Start a new QueryBuilder for fluent query construction.
   *
   * @returns A fresh QueryBuilder instance
   *
   * @example
   * const results = await User.newQuery()
   *   .where('status', 'active')
   *   .orderBy('name')
   *   .limit(10)
   *   .get()
   */
  static newQuery<T extends typeof Model>(this: T, queryOptions?: ModelQueryOptions): QueryBuilder<TRecordFor<T>> {
    const builder = new QueryBuilder<TRecordFor<T>>(this, queryOptions)
    if (this.defaultScope) {
      this.defaultScope(builder)
    }
    // Apply named global scopes
    const registry = this.globalScopeRegistry
    if (registry && registry.size > 0) {
      registry.apply(builder)
    }
    return builder
  }

  /**
   * Create a new QueryBuilder without applying any default scopes.
   * Useful for querying soft-deleted records or bypassing global filters.
   *
   * @returns A fresh QueryBuilder instance with no scopes applied
   */
  static newQueryWithoutScopes<T extends typeof Model>(this: T, queryOptions?: ModelQueryOptions): QueryBuilder<TRecordFor<T>> {
    return new QueryBuilder<TRecordFor<T>>(this, queryOptions)
  }

  /**
   * Whether this model carries a filter that every query must apply.
   *
   * The entry points that talk to the adapter directly check this to decide
   * whether they can take the fast path; anything that returns a QueryBuilder
   * goes through `newQuery()` unconditionally.
   */
  protected static hasScopes(): boolean {
    return Boolean(this.defaultScope) || Boolean(this.globalScopeRegistry && this.globalScopeRegistry.size > 0)
  }

  /**
   * Apply a named query scope.
   *
   * @param name - The scope name defined in `static scopes`
   * @returns A QueryBuilder with the scope applied
   *
   * @example
   * const published = await Post.scope('published').get()
   * const popularPublished = await Post.scope('published').scope('popular').get()
   */
  static scope<T extends typeof Model>(this: T, name: string): QueryBuilder<TRecordFor<T>> {
    const scopes = this.scopes
    if (!scopes || typeof scopes[name] !== 'function') {
      throw new Error(`${this.name}: unknown scope "${name}".`)
    }
    const builder = this.newQuery()
    return scopes[name](builder) as QueryBuilder<TRecordFor<T>>
  }

  /**
   * Define a one-to-many relationship.
   *
   * @param name - Relation name (used in `with()` calls)
   * @param related - The related model class
   * @param foreignKey - Foreign key column on the related model
   * @param localKey - Local key column on this model
   *
   * @example
   * class User extends Model<UserRecord> {
   *   static {
   *     this.hasMany('posts', Post, 'userId', 'id')
   *   }
   * }
   * // Later: User.with('posts')
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
   * Define a many-to-one (inverse) relationship.
   *
   * @param name - Relation name (used in `with()` calls)
   * @param related - The related model class
   * @param foreignKey - Foreign key column on this model
   * @param ownerKey - Primary key column on the related model
   *
   * @example
   * class Post extends Model<PostRecord> {
   *   static {
   *     this.belongsTo('author', User, 'userId', 'id')
   *   }
   * }
   * // Later: Post.with('author')
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
   * Define a one-to-one relationship.
   *
   * @param name - Relation name (used in `with()` calls)
   * @param related - The related model class
   * @param foreignKey - Foreign key column on the related model
   * @param localKey - Local key column on this model
   *
   * @example
   * class User extends Model<UserRecord> {
   *   static {
   *     this.hasOne('profile', Profile, 'userId', 'id')
   *   }
   * }
   * // Later: User.with('profile')
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
   * Define a many-to-many relationship via a pivot table.
   *
   * @param name - Relation name (used in `with()` calls)
   * @param related - The related model class
   * @param pivotTable - The pivot/junction table (e.g., Drizzle table schema)
   * @param foreignPivotKey - Column on pivot table referencing this model
   * @param relatedPivotKey - Column on pivot table referencing the related model
   * @param parentKey - Local key on this model (default: 'id')
   * @param relatedKey - Local key on the related model (default: 'id')
   *
   * @example
   * class User extends Model<UserRecord> {
   *   static {
   *     this.belongsToMany('roles', Role, userRoles, 'userId', 'roleId', 'id', 'id')
   *   }
   * }
   * // Later: User.with('roles')
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
   * Define a has-many-through relationship.
   *
   * @param name - Relation name (used in `with()` calls)
   * @param related - The final related model class
   * @param through - The intermediate model class
   * @param firstKey - Foreign key on the intermediate model referencing this model
   * @param secondKey - Foreign key on the related model referencing the intermediate model
   * @param localKey - Local key on this model (default: 'id')
   * @param secondLocalKey - Local key on the intermediate model (default: 'id')
   *
   * @example
   * class Country extends Model<CountryRecord> {
   *   static {
   *     this.hasManyThrough('posts', Post, User, 'countryId', 'userId', 'id', 'id')
   *   }
   * }
   * // Later: Country.with('posts')
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

  /**
   * Map of type strings to model classes for polymorphic relationships.
   *
   * @example
   * Model.morphMap = { Post, Video }
   */
  static morphMap?: Record<string, typeof Model>

  /**
   * Define a one-to-many polymorphic relationship.
   *
   * @param name - Relation name
   * @param related - The related model class
   * @param morphName - Base name for the type/id columns (e.g. 'commentable' → commentableType + commentableId)
   * @param localKey - Local key on this model (default: 'id')
   *
   * @example
   * Post.morphMany('comments', Comment, 'commentable', 'id')
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

  /**
   * Define the inverse of a polymorphic relationship.
   *
   * @param name - Relation name
   * @param morphName - Base name for the type/id columns
   *
   * @example
   * Comment.morphTo('commentable', 'commentable')
   */
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
   * Get records sorted by the specified order.
   *
   * @param order - Order expression(s)
   * @param where - Optional filter conditions
   * @returns Sorted array of records
   *
   * @example
   * // Single column ascending
   * await User.orderBy('createdAt')
   *
   * // Single column descending
   * await User.orderBy(['createdAt', 'desc'])
   *
   * // Multiple columns
   * await User.orderBy([['lastName', 'asc'], ['firstName', 'asc']])
   *
   * // With where clause
   * await User.orderBy('name', { status: 'active' })
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
   * Get paginated records.
   *
   * @param options - Pagination options
   * @returns Paginated result with data and metadata
   *
   * @example
   * const result = await User.paginate({ page: 1, perPage: 10 })
   * // result.data - Array of users
   * // result.meta.total - Total count
   * // result.meta.hasMore - Whether there are more pages
   *
   * // With filtering and ordering
   * await User.paginate({
   *   page: 2,
   *   perPage: 20,
   *   where: { status: 'active' },
   *   orderBy: ['createdAt', 'desc']
   * })
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

  /**
   * Paginate records with eager-loaded relationships.
   *
   * @param relations - Relation name(s) to load
   * @param options - Pagination options
   * @returns Paginated result with loaded relationships
   *
   * @example
   * const result = await User.withPaginate('posts', { page: 1, perPage: 10 })
   * // result.data - Users with their posts loaded
   * // result.meta - Pagination metadata
   */
  static async withPaginate<T extends typeof Model, K extends RelationPath<T>>(
    this: T,
    relations: K | readonly K[],
    options?: PaginateOptions<TRecordFor<T>>,
  ): Promise<PaginatedResult<TRecordFor<T> & RelationTypePick<T, K | readonly K[]>>>

  static async withPaginate<T extends typeof Model, Names extends RelationNames>(
    this: T,
    relations: Names,
    options: PaginateOptions<TRecordFor<T>> = {},
  ): Promise<PaginatedResult<TRecordFor<T> & RelationTypePick<T, Names>>> {
    const result = await this.paginate(options)
    const relationList = normalizeRelations(relations)

    if (relationList.length === 0 || result.data.length === 0) {
      return result as PaginatedResult<TRecordFor<T> & RelationTypePick<T, Names>>
    }

    const records = result.data.map((record) => ({ ...record }))

    for (const relationName of relationList) {
      await this.loadRelationInto(records, relationName)
    }

    return {
      data: records as Array<TRecordFor<T> & RelationTypePick<T, Names>>,
      meta: result.meta,
    }
  }

  /**
   * Create a new record.
   *
   * @param data - Record data to insert
   * @returns The created record
   *
   * @example
   * const user = await User.create({
   *   name: 'John Doe',
   *   email: 'john@example.com'
   * })
   */
  static async create<T extends typeof Model>(
    this: T,
    data: TCreateFor<T>,
    writeOptions?: ModelWriteOptions,
  ): Promise<TRecordFor<T>> {
    return this.runCreate(data, writeOptions, true)
  }

  /**
   * Create a record bypassing mass-assignment protection. Use for trusted,
   * server-side-assembled data (OAuth account linking, seeders, system
   * records) — never for raw request input.
   *
   * @example
   * const user = await User.forceCreate({
   *   name: profile.name,
   *   email: profile.email,
   *   passwordHash: `oauth:${provider}:${profile.id}`,
   * })
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

  /**
   * Update records matching the conditions.
   *
   * @param where - Filter conditions to identify records
   * @param data - Data to update
   * @returns The updated record
   *
   * @example
   * await User.update({ id: 1 }, { name: 'Jane Doe' })
   */
  static async update<T extends typeof Model>(
    this: T,
    where: WhereClauseFor<T>,
    data: Partial<TCreateFor<T>>,
    writeOptions?: ModelWriteOptions,
  ): Promise<TRecordFor<T>> {
    return this.runUpdate(where, data, writeOptions, true)
  }

  /**
   * Update records bypassing mass-assignment protection. Use for trusted,
   * server-side-assembled data — never for raw request input.
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

    // Global scopes must reach writes, not just reads: a tenant scope that is
    // applied to `find`/`all` but dropped here lets one tenant update another
    // tenant's rows. Route through the scope-applying builder, but hand it the
    // already-prepared payload so mutators/casts (and hooks above) run once.
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

  /**
   * Delete records matching the conditions.
   *
   * @param where - Filter conditions to identify records
   * @returns Number of deleted records or void depending on adapter
   *
   * @example
   * await User.delete({ id: 1 })
   * await User.delete({ status: 'inactive' })
   */
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
   * Get a raw Drizzle query builder for complex queries.
   *
   * @param db - Optional Drizzle database instance
   * @returns Drizzle query builder starting with `select().from(table)`
   *
   * @example
   * // Simple query
   * const users = await User.query(db)
   *   .where(eq(users.status, 'active'))
   *   .limit(10)
   *
   * // With joins
   * const usersWithPosts = await User.query(db)
   *   .leftJoin(posts, eq(users.id, posts.userId))
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
   * Eager-load relationships on records.
   *
   * @param relations - Relation name(s) to load
   * @param where - Optional filter conditions
   * @returns Records with loaded relationships
   *
   * @example
   * // Single relation
   * const usersWithPosts = await User.with('posts')
   *
   * // Multiple relations
   * const usersWithAll = await User.with(['posts', 'comments'])
   *
   * // With filtering
   * const activeUsersWithPosts = await User.with('posts', { status: 'active' })
   *
   * // Nested relations via dot notation
   * const usersWithPostComments = await User.with('posts.comments')
   */
  static async with<T extends typeof Model, K extends RelationPath<T>>(
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

  /**
   * Fetch records with related record counts attached as `${name}Count`.
   * Counts hasMany/hasOne/morphMany children per record without attaching
   * the related rows themselves; belongsTo yields 0 or 1.
   *
   * @example
   * const users = await User.withCount('posts')
   * users[0].postsCount // number
   */
  static async withCount<T extends typeof Model, K extends RelationKey<T>>(
    this: T,
    relations: K | readonly K[],
    where?: WhereClauseFor<T>,
  ): Promise<Array<TRecordFor<T> & RelationCountPick<K | readonly K[]>>>

  static async withCount<T extends typeof Model, Names extends RelationNames>(
    this: T,
    relations: Names,
    where?: WhereClauseFor<T>,
  ): Promise<Array<TRecordFor<T> & RelationCountPick<Names>>> {
    const records = where ? await this.where(where) : await this.all()
    if (!records.length) {
      return records as Array<TRecordFor<T> & RelationCountPick<Names>>
    }

    const relationList = normalizeRelations(relations)
    const copies = records.map((record) => ({ ...record })) as Array<PlainObject>
    for (const relationName of relationList) {
      await this.loadRelationCountInto(copies, relationName)
    }

    return copies as Array<TRecordFor<T> & RelationCountPick<Names>>
  }

  /** @internal Attaches a `${name}Count` field for one relation. */
  protected static async loadRelationCountInto<T extends typeof Model>(
    this: T,
    records: Array<PlainObject>,
    relationName: string,
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
          const relatedRecords = (await related.where({ [foreignKey]: values } as WhereClause)) as PlainObject[]
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
        await this.loadRelationInto(withRelation, relationName)
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
          const owners = (await related.where({ [ownerKey]: values } as WhereClause)) as PlainObject[]
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
   * @internal Used by QueryBuilder for eager loading.
   * Supports nested paths with dot notation, e.g. `posts.comments`.
   */
  static async loadRelationInto<T extends typeof Model>(
    this: T,
    records: Array<PlainObject>,
    relationName: string,
  ): Promise<void> {
    const [head, ...rest] = relationName.split('.')
    const definition = this.getRelationDefinition(head)

    if (!definition) {
      throw new Error(`${this.name}: unknown relation "${head}".`)
    }

    switch (definition.type) {
      case 'hasMany':
        await this.loadHasMany(records, definition)
        break
      case 'hasOne':
        await this.loadHasOne(records, definition)
        break
      case 'belongsTo':
        await this.loadBelongsTo(records, definition)
        break
      case 'belongsToMany':
        await this.loadBelongsToMany(records, definition)
        break
      case 'hasManyThrough':
        await this.loadHasManyThrough(records, definition)
        break
      case 'morphMany':
        await this.loadMorphMany(records, definition)
        break
      case 'morphTo':
        await this.loadMorphTo(records, definition)
        break
    }

    if (rest.length === 0) {
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
    await related.loadRelationInto(children, rest.join('.'))
  }

  protected static async loadHasMany(
    records: Array<PlainObject>,
    definition: HasManyRelationDefinition,
  ): Promise<void> {
    const { foreignKey, localKey, name } = definition
    const related = await resolveModelReference(definition.related)
    await loadRelationData(records, name, related, localKey, foreignKey, true)
  }

  protected static async loadHasOne(
    records: Array<PlainObject>,
    definition: HasOneRelationDefinition,
  ): Promise<void> {
    const { foreignKey, localKey, name } = definition
    const related = await resolveModelReference(definition.related)
    await loadRelationData(records, name, related, localKey, foreignKey, false)
  }

  protected static async loadBelongsTo(
    records: Array<PlainObject>,
    definition: BelongsToRelationDefinition,
  ): Promise<void> {
    const { foreignKey, ownerKey, name } = definition
    const related = await resolveModelReference(definition.related)
    await loadRelationData(records, name, related, foreignKey, ownerKey, false)
  }

  protected static async loadBelongsToMany(
    records: Array<PlainObject>,
    definition: BelongsToManyRelationDefinition,
  ): Promise<void> {
    const { pivotTable, foreignPivotKey, relatedPivotKey, parentKey, relatedKey, name } = definition
    const related = await resolveModelReference(definition.related)

    // Collect parent key values
    const parentValues = Array.from(
      new Set(records.map((r) => r[parentKey]).filter((v): v is unknown => v != null)),
    )

    if (parentValues.length === 0) {
      for (const record of records) {
        record[name] = []
      }
      return
    }

    // Step 1: Query pivot table for matching pivot rows
    const adapter = this.getAdapter()
    const pivotRows = await adapter.findMany<PlainObject>(pivotTable, {
      where: { [foreignPivotKey]: parentValues } as WhereClause,
    })

    // Build a map: parentKeyValue -> relatedKeyValue[]
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

    // Step 2: Query related table for those IDs
    const relatedRecords = await related.where({
      [relatedKey]: Array.from(allRelatedIds),
    } as WhereClause) as PlainObject[]

    // Index related records by their key
    const relatedMap = new Map<unknown, PlainObject>()
    for (const item of relatedRecords) {
      relatedMap.set(item[relatedKey], { ...item })
    }

    // Assign to each parent record
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
  ): Promise<void> {
    const { firstKey, secondKey, localKey, secondLocalKey, name } = definition
    const related = await resolveModelReference(definition.related)
    const through = await resolveModelReference(definition.through)

    // Collect local key values from parent records
    const localValues = Array.from(
      new Set(records.map((r) => r[localKey]).filter((v): v is unknown => v != null)),
    )

    if (localValues.length === 0) {
      for (const record of records) {
        record[name] = []
      }
      return
    }

    // Step 1: Query through model for intermediate records
    const throughRecords = await through.where({
      [firstKey]: localValues,
    } as WhereClause) as PlainObject[]

    // Build a map: parentLocalKeyValue -> throughSecondLocalKey[]
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

    // Step 2: Query related model using through model's keys
    const relatedRecords = await related.where({
      [secondKey]: Array.from(allThroughIds),
    } as WhereClause) as PlainObject[]

    // Index related records by secondKey
    const relatedByKey = new Map<unknown, PlainObject[]>()
    for (const item of relatedRecords) {
      const key = item[secondKey]
      if (!relatedByKey.has(key)) relatedByKey.set(key, [])
      relatedByKey.get(key)!.push({ ...item })
    }

    // Assign to each parent record
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

    const allRelated = await related.where({
      [typeColumn]: parentType,
      [idColumn]: localValues,
    } as WhereClause) as PlainObject[]

    const map = new Map<unknown, PlainObject[]>()
    for (const item of allRelated) {
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
  ): Promise<void> {
    const { morphName, name } = definition
    const typeColumn = `${morphName}Type`
    const idColumn = `${morphName}Id`
    const morphMap = Model.morphMap ?? {}

    // Group records by type
    const byType = new Map<string, unknown[]>()
    for (const record of records) {
      const type = record[typeColumn] as string
      const id = record[idColumn]
      if (!type || id == null) continue
      if (!byType.has(type)) byType.set(type, [])
      byType.get(type)!.push(id)
    }

    // Fetch each type's records
    const resolved = new Map<string, Map<unknown, PlainObject>>()
    for (const [type, ids] of byType) {
      const modelClass = morphMap[type]
      if (!modelClass) continue
      const uniqueIds = Array.from(new Set(ids))
      const results = await modelClass.where({ id: uniqueIds } as WhereClause) as PlainObject[]
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

async function loadRelationData(
  records: PlainObject[],
  name: string,
  related: typeof Model,
  parentKey: string,
  relatedKey: string,
  isArray: boolean,
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

  const relatedRecords = await related.where({ [relatedKey]: values } as WhereClause)
  const map = new Map<unknown, PlainObject | PlainObject[]>()

  for (const item of relatedRecords as PlainObject[]) {
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

// A declared relation key, or a dot-notation nested path rooted at one
// ('comments.author'). Only the head segment is checked against
// relationTypes — the tail is an unvalidated string, so a malformed path
// ('comments.', 'comments..author') or a typo'd nested segment still
// type-checks. loadRelationInto() throws "unknown relation" for a bad tail
// segment at runtime, but only once it actually recurses into at least one
// loaded child row — if every record's head relation loads zero rows, the
// tail is never inspected and the call silently no-ops. Declare the nested
// record shape inside relationTypes to type the loaded children.
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

/** Type for hasMany relation results (array of related records). */
export type HasManyRelationResult<T extends typeof Model> = Array<TRecordFor<T>>

/** Type for belongsTo relation results (single record or null). */
export type BelongsToRelationResult<T extends typeof Model> = TRecordFor<T> | null

/** Utility type for hasMany relation data shape. */
export type HasManyRecord<TRecord extends PlainObject> = TRecord[]

/** Utility type for belongsTo relation data shape. */
export type BelongsToRecord<TRecord extends PlainObject> = TRecord | null

/**
 * Utility type for belongsTo relations backed by a NOT NULL foreign key,
 * where the parent is guaranteed to exist once loaded. Declare with the
 * `declare` modifier so no runtime placeholder value is needed:
 *
 * @example
 * declare static relationTypes: { author: BelongsToRequiredRecord<UserRecord> }
 */
export type BelongsToRequiredRecord<TRecord extends PlainObject> = TRecord

/** Type for hasOne relation results (single record or null). */
export type HasOneRelationResult<T extends typeof Model> = TRecordFor<T> | null

/** Type for belongsToMany relation results (array of related records). */
export type BelongsToManyRelationResult<T extends typeof Model> = Array<TRecordFor<T>>

/** Type for hasManyThrough relation results (array of related records). */
export type HasManyThroughRelationResult<T extends typeof Model> = Array<TRecordFor<T>>

/** Utility type for hasOne relation data shape. */
export type HasOneRecord<TRecord extends PlainObject> = TRecord | null

/** Utility type for belongsToMany relation data shape. */
export type BelongsToManyRecord<TRecord extends PlainObject> = TRecord[]

/** Utility type for hasManyThrough relation data shape. */
export type HasManyThroughRecord<TRecord extends PlainObject> = TRecord[]

/** Type for morphMany relation results (array of related records). */
export type MorphManyRelationResult<T extends typeof Model> = Array<TRecordFor<T>>

/** Utility type for morphMany relation data shape. */
export type MorphManyRecord<TRecord extends PlainObject> = TRecord[]

/** Type for morphTo relation results (single record or null). */
export type MorphToRelationResult = PlainObject | null

/** Utility type for morphTo relation data shape. */
export type MorphToRecord = PlainObject | null

/** Utility type: model record with specified relations merged. */
export type WithRelations<
  T extends typeof Model,
  K extends RelationPath<T> | readonly RelationPath<T>[],
> = TRecordFor<T> & RelationTypePick<T, K>

type ModelClassWithTable<TTable extends TableShape, TBase extends typeof Model, TCreate extends PlainObject> = TBase & {
  readonly table: TTable
  readonly recordType: InferModelRecord<TTable>
  readonly createType: TCreate
}

/** A key that can appear in a model's create payload: a table column, or a named field its base contributes. */
type CreateKey<TTable extends TableShape, TBase extends typeof Model> =
  | keyof InferModelInsert<TTable>
  | keyof TCreateFor<TBase>

/**
 * Named fields a base class contributes to the create payload, such as
 * `AuthenticatableModel`'s virtual `password`. A plain `Model` base has no
 * declared createType, so its keys collapse to `string` — guard against that
 * collapse, or every misspelling would pass the allowlist checks below.
 */
type BaseContributedKey<TBase extends typeof Model> =
  string extends keyof TCreateFor<TBase> & string ? never : keyof TCreateFor<TBase> & string

/** A key valid in a `fillable` allowlist: an insertable column, or a base-contributed field. */
type FillableKey<TTable extends TableShape, TBase extends typeof Model> =
  | (keyof InferModelInsert<TTable> & string)
  | BaseContributedKey<TBase>

/** A key of the record read back from the table. */
type RecordKey<TTable extends TableShape> = keyof InferModelRecord<TTable> & string

/**
 * Accessor map keyed by TKey whose functions receive the table's inferred
 * record. A homomorphic mapped type so TypeScript infers the key union from
 * the object literal's keys — a plain `Record<string, fn>` constraint fails
 * here: the accessor functions are context-sensitive, which defers inference
 * past the point where the key type parameter falls back to its default.
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
 * Create a table-backed model base class from a Drizzle table.
 *
 * `recordType` and `createType` are inferred from the table. The inferred
 * createType requires every non-defaulted column, which is not always the
 * payload a model accepts: `AuthenticatableModel` hashes a plain `password`
 * into `passwordHash`, so a user model wants the column optional and the
 * virtual field required. `optionalOnCreate` and `requireOnCreate` reshape the
 * inferred type without any cast.
 *
 * The allowlist statics (`fillable`, `hidden`, `visible`, `accessors`,
 * `appends`) can be passed here instead of declared on the subclass: the
 * option form checks every name against the table's columns (plus fields the
 * `base` contributes), so a typo is a compile error instead of a silently
 * ineffective entry. A `static` declaration on the subclass still works and
 * shadows the option, matching normal class semantics.
 *
 * @example
 * export class Post extends defineModel(posts, {
 *   fillable: ['title', 'body'],
 * }) {}
 *
 * export class User extends defineModel(users, {
 *   base: AuthenticatableModel,
 *   optionalOnCreate: ['passwordHash'],
 *   requireOnCreate: ['password'],
 *   fillable: ['name', 'email', 'password'],
 *   hidden: ['passwordHash', 'rememberToken'],
 * }) {}
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
    /**
     * Columns the model fills in itself, so callers need not pass them.
     * Type-level only.
     */
    optionalOnCreate?: readonly TOptional[]
    /**
     * Fields to make required on the create payload. Accepts table columns
     * (Drizzle marks defaulted ones optional) and named fields contributed by
     * `base`, such as `AuthenticatableModel`'s virtual `password`.
     * Type-level only.
     */
    requireOnCreate?: readonly TRequire[]
    /**
     * Typed form of `static fillable`: mass-assignment allowlist checked
     * against insertable columns and base-contributed fields.
     */
    fillable?: readonly FillableKey<TTable, TBase>[]
    /**
     * Typed form of `static hidden`: fields excluded from serialization,
     * checked against record columns and declared accessors.
     */
    hidden?: readonly (RecordKey<TTable> | NoInfer<TAccessorKey>)[]
    /**
     * Typed form of `static visible`: serialization allowlist, checked
     * against record columns and declared accessors.
     */
    visible?: readonly (RecordKey<TTable> | NoInfer<TAccessorKey>)[]
    /**
     * Typed form of `static accessors`: each function receives the table's
     * inferred record. Names declared here are what `appends` may reference.
     * The Record intersection rejects non-object values — with no keys to
     * infer, the mapped type alone collapses to `{}`, which admits anything.
     */
    accessors?: AccessorsShape<TTable, TAccessorKey> &
      Record<string, (record: InferModelRecord<TTable>) => unknown>
    /**
     * Typed form of `static appends`: virtual attributes to serialize,
     * checked against the names declared in `accessors`.
     */
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
