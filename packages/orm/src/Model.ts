import { DrizzleAdapter } from './adapters/drizzle-adapter'
import { executeHook } from './hooks'
import type { ModelHooks } from './hooks'
import { ModelNotFoundException } from './ModelNotFoundException'
import { QueryBuilder } from './QueryBuilder'
import type { WhereOperator } from './QueryBuilder'

/** Generic plain object type used throughout the ORM. */
export type PlainObject = Record<string, unknown>

type RelationShape = Record<string, unknown>

export const DEFAULT_PAGINATION_SIZE = 15

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
export interface PaginationMeta {
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
  meta: PaginationMeta
}

/**
 * Interface for ORM adapters that power the Model class.
 * The default adapter is DrizzleAdapter.
 */
export interface ORMAdapter {
  /** Find multiple records with optional filtering, ordering, and pagination. */
  findMany<TRecord extends PlainObject = PlainObject>(table: unknown, options?: FindManyOptions<TRecord>): Promise<TRecord[]>
  /** Find a single record by unique criteria. */
  findUnique<TRecord extends PlainObject = PlainObject>(table: unknown, where: WhereClause<TRecord>): Promise<TRecord | null>
  /** Create a new record. */
  create<TRecord extends PlainObject = PlainObject>(table: unknown, data: PlainObject): Promise<TRecord>
  /** Update records matching criteria. */
  update?<TRecord extends PlainObject = PlainObject>(
    table: unknown,
    where: WhereClause<TRecord>,
    data: PlainObject,
  ): Promise<TRecord>
  /** Delete records matching criteria. */
  delete?<TRecord extends PlainObject = PlainObject>(
    table: unknown,
    where: WhereClause<TRecord>,
  ): Promise<number | PlainObject | void>
  /** Count records matching criteria. */
  count?<TRecord extends PlainObject = PlainObject>(table: unknown, where?: WhereClause<TRecord>): Promise<number>
}

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
 * // Define a model
 * class User extends Model<UserRecord> {
 *   static override table = users  // Drizzle table
 *   static override readonly recordType = {} as UserRecord
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
  /** Type marker for TypeScript inference. Define as `{} as YourRecordType`. */
  static readonly recordType: unknown = undefined as unknown
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
   * If set, only these fields will be accepted in `create()` and `update()`.
   *
   * @example
   * class User extends Model<UserRecord> {
   *   static fillable = ['name', 'email', 'password']
   * }
   */
  static fillable?: string[]

  /**
   * Blacklist of fields excluded from mass assignment.
   * Defaults to `['id']`. Ignored if `fillable` is set.
   *
   * @example
   * class Post extends Model<PostRecord> {
   *   static guarded = ['id', 'createdAt']
   * }
   */
  static guarded?: string[]

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
   * Filter input data based on mass assignment protection rules.
   *
   * If `fillable` is defined, only fields listed in `fillable` are kept.
   * Otherwise, fields listed in `guarded` (default: `['id']`) are removed.
   *
   * @param data - The input data to filter
   * @returns Filtered data safe for mass assignment
   */
  static filterFillable(data: PlainObject): PlainObject {
    const fillableFields = this.fillable
    if (fillableFields) {
      const filtered: PlainObject = {}
      for (const key of fillableFields) {
        if (key in data) {
          filtered[key] = data[key]
        }
      }
      return filtered
    }

    const guardedFields = this.guarded ?? ['id']
    const hasGuardedKey = guardedFields.some((key) => key in data)
    if (!hasGuardedKey) {
      return data
    }
    const filtered: PlainObject = { ...data }
    for (const key of guardedFields) {
      delete filtered[key]
    }
    return filtered
  }

  protected static async preparePersistencePayload(data: PlainObject): Promise<PlainObject> {
    const result = { ...data }
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

  protected static getRelationDefinitions(): Map<string, RelationDefinition> {
    if (!Object.prototype.hasOwnProperty.call(this, 'relationDefinitions') || !this.relationDefinitions) {
      this.relationDefinitions = new Map()
    }

    return this.relationDefinitions
  }

  protected static getRelationDefinition(name: string): RelationDefinition | undefined {
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
  static async all<T extends typeof Model>(this: T): Promise<Array<TRecordFor<T>>> {
    if (this.defaultScope) {
      return this.newQuery().get()
    }
    const table = this.resolveTable()
    const records = await this.getAdapter().findMany(table) as Array<TRecordFor<T>>
    if (this.casts) {
      return records.map((r) => this.applyCasts(r))
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
  static async find<T extends typeof Model>(this: T, id: unknown, key = 'id'): Promise<TRecordFor<T> | null> {
    if (this.defaultScope) {
      return this.newQuery().where(key, id).first()
    }
    const table = this.resolveTable()
    const where = { [key]: id } as WhereClauseFor<T>
    const record = await this.getAdapter().findUnique(table, where) as TRecordFor<T> | null
    if (record && this.casts) {
      return this.applyCasts(record)
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
  static async findOrFail<T extends typeof Model>(this: T, id: unknown, key = 'id'): Promise<TRecordFor<T>> {
    const record = await this.find(id, key)
    if (record == null) {
      throw new ModelNotFoundException(this.name, id, key)
    }
    return record
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
  static async first<T extends typeof Model>(this: T, where?: WhereClauseFor<T>): Promise<TRecordFor<T> | null> {
    if (this.defaultScope) {
      const builder = this.newQuery().limit(1)
      if (where) {
        builder.where(where as Partial<Record<string, unknown>>)
      }
      const results = await builder.get()
      return (results[0] ?? null) as TRecordFor<T> | null
    }
    const table = this.resolveTable()
    const results = await this.getAdapter().findMany(table, { where, limit: 1 })
    const record = (results[0] ?? null) as TRecordFor<T> | null
    if (record && this.casts) {
      return this.applyCasts(record)
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
  static where<T extends typeof Model>(this: T, conditions: WhereClauseFor<T>): QueryBuilder<TRecordFor<T>>
  static where<T extends typeof Model>(this: T, field: string, value: unknown): QueryBuilder<TRecordFor<T>>
  static where<T extends typeof Model>(this: T, field: string, operator: WhereOperator, value: unknown): QueryBuilder<TRecordFor<T>>
  static where<T extends typeof Model>(
    this: T,
    fieldOrConditions: string | WhereClauseFor<T>,
    operatorOrValue?: unknown,
    value?: unknown,
  ): QueryBuilder<TRecordFor<T>> {
    const builder = new QueryBuilder<TRecordFor<T>>(this)

    if (typeof fieldOrConditions === 'object' && fieldOrConditions !== null) {
      return builder.where(fieldOrConditions as Partial<Record<string, unknown>>)
    }

    if (arguments.length === 3) {
      return builder.where(fieldOrConditions as string, operatorOrValue as WhereOperator, value)
    }

    return builder.where(fieldOrConditions as string, operatorOrValue)
  }

  /**
   * Start a fluent query with a WHERE NULL condition.
   * @param field - Column to check for NULL
   */
  static whereNull<T extends typeof Model>(this: T, field: string): QueryBuilder<TRecordFor<T>> {
    return new QueryBuilder<TRecordFor<T>>(this).whereNull(field)
  }

  /**
   * Start a fluent query with a WHERE NOT NULL condition.
   * @param field - Column to check for NOT NULL
   */
  static whereNotNull<T extends typeof Model>(this: T, field: string): QueryBuilder<TRecordFor<T>> {
    return new QueryBuilder<TRecordFor<T>>(this).whereNotNull(field)
  }

  /**
   * Start a fluent query with a WHERE IN condition.
   * @param field - Column to check
   * @param values - Array of values to match against
   */
  static whereIn<T extends typeof Model>(this: T, field: string, values: unknown[]): QueryBuilder<TRecordFor<T>> {
    return new QueryBuilder<TRecordFor<T>>(this).whereIn(field, values)
  }

  /**
   * Start a fluent query with a WHERE NOT IN condition.
   * @param field - Column to check
   * @param values - Array of values to exclude
   */
  static whereNotIn<T extends typeof Model>(this: T, field: string, values: unknown[]): QueryBuilder<TRecordFor<T>> {
    return new QueryBuilder<TRecordFor<T>>(this).whereNotIn(field, values)
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
  static newQuery<T extends typeof Model>(this: T): QueryBuilder<TRecordFor<T>> {
    const builder = new QueryBuilder<TRecordFor<T>>(this)
    if (this.defaultScope) {
      this.defaultScope(builder)
    }
    return builder
  }

  /**
   * Create a new QueryBuilder without applying any default scopes.
   * Useful for querying soft-deleted records or bypassing global filters.
   *
   * @returns A fresh QueryBuilder instance with no scopes applied
   */
  static newQueryWithoutScopes<T extends typeof Model>(this: T): QueryBuilder<TRecordFor<T>> {
    return new QueryBuilder<TRecordFor<T>>(this)
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
    const builder = new QueryBuilder<TRecordFor<T>>(this)
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
    related: Related,
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
    related: Related,
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
    related: Related,
    through: Through,
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
  ): Promise<TRecordFor<T>[]> {
    const table = this.resolveTable()
    const orderBy = normalizeOrderBy(order)
    const options: FindManyOptions<TRecordFor<T>> = { orderBy }

    if (where && Object.keys(where).length > 0) {
      options.where = where
    }

    return this.getAdapter().findMany(table, options) as Promise<TRecordFor<T>[]>
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
  ): Promise<PaginatedResult<TRecordFor<T>>> {
    const table = this.resolveTable()
    const adapter = this.getAdapter()

    const requestedPage = typeof options.page === 'number' ? options.page : 1
    const sanitizedPage = Number.isFinite(requestedPage) && requestedPage >= 1 ? Math.floor(requestedPage) : 1

    const requestedPerPage = typeof options.perPage === 'number' ? options.perPage : DEFAULT_PAGINATION_SIZE
    const perPage = Number.isFinite(requestedPerPage) && requestedPerPage >= 1 ? Math.floor(requestedPerPage) : DEFAULT_PAGINATION_SIZE

    let total = 0
    if (typeof adapter.count === 'function') {
      total = await adapter.count(table, options.where as WhereClauseFor<T>)
    } else {
      const records = options.where
        ? await this.where(options.where as WhereClauseFor<T>)
        : await this.all()
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

    const data = await adapter.findMany(table, findOptions) as Array<TRecordFor<T>>

    const from = total === 0 ? 0 : offset + 1
    const to = total === 0 ? 0 : offset + data.length

    const meta: PaginationMeta = {
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
  static async withPaginate<T extends typeof Model, K extends RelationKey<T>>(
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
  static async create<T extends typeof Model>(this: T, data: PlainObject): Promise<TRecordFor<T>> {
    const table = this.resolveTable()
    const filtered = this.filterFillable(data)
    const payload = await this.preparePersistencePayload(filtered)

    const hooks = this.hooks
    if (hooks) {
      if (!(await executeHook(hooks, 'creating', payload))) {
        throw new Error(`${this.name}.create() aborted by 'creating' hook.`)
      }
      if (!(await executeHook(hooks, 'saving', payload))) {
        throw new Error(`${this.name}.create() aborted by 'saving' hook.`)
      }
    }

    const result = await this.getAdapter().create(table, payload) as TRecordFor<T>

    if (hooks) {
      const resultData = result as unknown as Record<string, unknown>
      await executeHook(hooks, 'created', resultData)
      await executeHook(hooks, 'saved', resultData)
    }

    if (this.casts) {
      return this.applyCasts(result)
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
  static async update<T extends typeof Model>(this: T, where: WhereClauseFor<T>, data: PlainObject): Promise<TRecordFor<T>> {
    const table = this.resolveTable()
    const adapter = this.getAdapter()
    if (!adapter.update) {
      throw new Error('Configured adapter does not support update operations.')
    }

    const filtered = this.filterFillable(data)
    const payload = await this.preparePersistencePayload(filtered)

    const hooks = this.hooks
    if (hooks) {
      if (!(await executeHook(hooks, 'updating', payload))) {
        throw new Error(`${this.name}.update() aborted by 'updating' hook.`)
      }
      if (!(await executeHook(hooks, 'saving', payload))) {
        throw new Error(`${this.name}.update() aborted by 'saving' hook.`)
      }
    }

    const result = await adapter.update(table, where, payload) as TRecordFor<T>

    if (hooks) {
      const resultData = result as unknown as Record<string, unknown>
      await executeHook(hooks, 'updated', resultData)
      await executeHook(hooks, 'saved', resultData)
    }

    if (this.casts) {
      return this.applyCasts(result)
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
  static async delete<T extends typeof Model>(this: T, where: WhereClauseFor<T>): Promise<number | PlainObject | void> {
    const table = this.resolveTable()
    const adapter = this.getAdapter()
    if (!adapter.delete) {
      throw new Error('Configured adapter does not support delete operations.')
    }

    const hooks = this.hooks
    const whereData = where as unknown as Record<string, unknown>
    if (hooks) {
      if (!(await executeHook(hooks, 'deleting', whereData))) {
        throw new Error(`${this.name}.delete() aborted by 'deleting' hook.`)
      }
    }

    const result = await adapter.delete(table, where)

    if (hooks) {
      await executeHook(hooks, 'deleted', whereData)
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
   */
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

    switch (definition.type) {
      case 'hasMany':
        await this.loadHasMany(records, definition)
        return
      case 'hasOne':
        await this.loadHasOne(records, definition)
        return
      case 'belongsTo':
        await this.loadBelongsTo(records, definition)
        return
      case 'belongsToMany':
        await this.loadBelongsToMany(records, definition)
        return
      case 'hasManyThrough':
        await this.loadHasManyThrough(records, definition)
        return
    }
  }

  protected static async loadHasMany(
    records: Array<PlainObject>,
    definition: HasManyRelationDefinition,
  ): Promise<void> {
    const { related, foreignKey, localKey, name } = definition
    await loadRelationData(records, name, related, localKey, foreignKey, true)
  }

  protected static async loadHasOne(
    records: Array<PlainObject>,
    definition: HasOneRelationDefinition,
  ): Promise<void> {
    const { related, foreignKey, localKey, name } = definition
    await loadRelationData(records, name, related, localKey, foreignKey, false)
  }

  protected static async loadBelongsTo(
    records: Array<PlainObject>,
    definition: BelongsToRelationDefinition,
  ): Promise<void> {
    const { related, foreignKey, ownerKey, name } = definition
    await loadRelationData(records, name, related, foreignKey, ownerKey, false)
  }

  protected static async loadBelongsToMany(
    records: Array<PlainObject>,
    definition: BelongsToManyRelationDefinition,
  ): Promise<void> {
    const { related, pivotTable, foreignPivotKey, relatedPivotKey, parentKey, relatedKey, name } = definition

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
    const { related, through, firstKey, secondKey, localKey, secondLocalKey, name } = definition

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
  type: 'hasMany' | 'hasOne' | 'belongsTo' | 'belongsToMany' | 'hasManyThrough'
  name: string
  related: typeof Model
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
  through: typeof Model
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

/** Type for hasMany relation results (array of related records). */
export type HasManyRelationResult<T extends typeof Model> = Array<TRecordFor<T>>

/** Type for belongsTo relation results (single record or null). */
export type BelongsToRelationResult<T extends typeof Model> = TRecordFor<T> | null

/** Utility type for hasMany relation data shape. */
export type HasManyRecord<TRecord extends PlainObject> = TRecord[]

/** Utility type for belongsTo relation data shape. */
export type BelongsToRecord<TRecord extends PlainObject> = TRecord | null

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
