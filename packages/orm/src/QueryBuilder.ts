import { DEFAULT_PAGINATION_SIZE } from './Model'
import { ModelNotFoundException } from './ModelNotFoundException'
import type {
  AdapterQueryOptions,
  FindManyOptions,
  Model,
  ORMAdapter,
  OrderByClause,
  OrderDirection,
  PaginatedResult,
  ModelPaginationMeta,
  PlainObject,
} from './Model'

type FieldKey<TRecord extends PlainObject> = keyof TRecord & string

/**
 * Key for the prepared-payload update terminal.
 *
 * Exported for `Model` to call across the module boundary, but deliberately
 * absent from the package entry point, so it is not part of the public API.
 */
export const PREPARED_UPDATE = Symbol('guren.orm.preparedUpdate')

/** Comparison operators supported by the QueryBuilder. */
export type WhereOperator = '=' | '!=' | '>' | '<' | '>=' | '<=' | 'like' | 'in' | 'not in' | 'is null' | 'is not null'

/** A single field-level condition. */
export interface SimpleCondition {
  type: 'simple'
  field: string
  operator: WhereOperator
  value: unknown
}

/** A group of conditions joined by AND or OR. */
export interface GroupCondition {
  type: 'group'
  boolean: 'and' | 'or'
  conditions: WhereCondition[]
}

/** A where condition - either simple or grouped. */
export type WhereCondition = SimpleCondition | GroupCondition

/** Options carried by the QueryBuilder for query execution. */
export interface QueryBuilderOptions {
  orderBy: Array<{ column: string; direction: OrderDirection }>
  limitValue?: number
  offsetValue?: number
  selectFields?: readonly string[]
  trx?: unknown
}

/**
 * Fluent query builder for the Guren ORM.
 *
 * Provides a chainable API for constructing database queries with
 * support for complex where conditions, ordering, pagination, and more.
 *
 * Implements the thenable pattern so it can be directly awaited,
 * resolving to the result of `get()`.
 *
 * @example
 * // Fluent chaining
 * const posts = await Post.where('status', 'published')
 *   .where('views', '>', 100)
 *   .orderBy('createdAt', 'desc')
 *   .limit(10)
 *   .get()
 *
 * // Thenable - await directly
 * const active = await User.where('active', true)
 *
 * // Pagination
 * const page = await Post.where('status', 'published').paginate(1, 20)
 */
export class QueryBuilder<
  TRecord extends PlainObject = PlainObject,
  TResult extends PlainObject = TRecord,
> {
  private conditions: WhereCondition[] = []
  private options: QueryBuilderOptions = { orderBy: [] }
  private modelClass: typeof Model
  private table: unknown
  private adapter: ORMAdapter
  private eagerLoad: string[] = []
  private eagerLoadConstraints: Map<string, (q: QueryBuilder<any>) => void> = new Map() // eslint-disable-line @typescript-eslint/no-explicit-any

  constructor(modelClass: typeof Model, options: { trx?: unknown } = {}) {
    this.modelClass = modelClass
    this.table = modelClass.resolveTable()
    this.adapter = modelClass.getAdapter()
    this.options.trx = options.trx
  }

  /**
   * Add a where condition (AND).
   *
   * Supports three calling signatures:
   * - `where(field, value)` - equality check
   * - `where(field, operator, value)` - comparison
   * - `where(object)` - multiple equality conditions
   */
  where<TKey extends FieldKey<TRecord>>(field: TKey, value: TRecord[TKey]): this
  where<TKey extends FieldKey<TRecord>>(field: TKey, operator: WhereOperator, value: unknown): this
  where(conditions: Partial<Record<FieldKey<TRecord>, unknown>>): this
  where(
    fieldOrConditions: FieldKey<TRecord> | Partial<Record<FieldKey<TRecord>, unknown>>,
    operatorOrValue?: unknown,
    value?: unknown,
  ): this {
    if (typeof fieldOrConditions === 'object' && fieldOrConditions !== null) {
      for (const [key, val] of Object.entries(fieldOrConditions)) {
        if (val !== undefined) {
          // Array values mean IN — mirrors the adapter's object-where contract
          this.addSimpleCondition(key, Array.isArray(val) ? 'in' : '=', val)
        }
      }
      return this
    }

    const field = fieldOrConditions as string

    if (arguments.length === 2) {
      this.addSimpleCondition(field, Array.isArray(operatorOrValue) ? 'in' : '=', operatorOrValue)
    } else {
      this.addSimpleCondition(field, operatorOrValue as WhereOperator, value)
    }

    return this
  }

  /**
   * Add an OR where condition.
   *
   * Same overloads as `where()`, but joins with OR logic.
   * Creates an OR group containing the new condition(s).
   */
  orWhere<TKey extends FieldKey<TRecord>>(field: TKey, value: TRecord[TKey]): this
  orWhere<TKey extends FieldKey<TRecord>>(field: TKey, operator: WhereOperator, value: unknown): this
  orWhere(conditions: Partial<Record<FieldKey<TRecord>, unknown>>): this
  orWhere(
    fieldOrConditions: FieldKey<TRecord> | Partial<Record<FieldKey<TRecord>, unknown>>,
    operatorOrValue?: unknown,
    value?: unknown,
  ): this {
    const orConditions: SimpleCondition[] = []

    if (typeof fieldOrConditions === 'object' && fieldOrConditions !== null) {
      for (const [key, val] of Object.entries(fieldOrConditions)) {
        if (val !== undefined) {
          orConditions.push({ type: 'simple', field: key, operator: Array.isArray(val) ? 'in' : '=', value: val })
        }
      }
    } else {
      const field = fieldOrConditions as string

      if (arguments.length === 2) {
        orConditions.push({ type: 'simple', field, operator: Array.isArray(operatorOrValue) ? 'in' : '=', value: operatorOrValue })
      } else {
        orConditions.push({ type: 'simple', field, operator: operatorOrValue as WhereOperator, value })
      }
    }

    if (orConditions.length > 0) {
      this.conditions.push({
        type: 'group',
        boolean: 'or',
        conditions: orConditions,
      })
    }

    return this
  }

  /**
   * Add a WHERE NULL condition.
   * @param field - Column to check for NULL
   */
  whereNull(field: FieldKey<TRecord>): this {
    this.addSimpleCondition(field, 'is null', null)
    return this
  }

  /**
   * Add a WHERE NOT NULL condition.
   * @param field - Column to check for NOT NULL
   */
  whereNotNull(field: FieldKey<TRecord>): this {
    this.addSimpleCondition(field, 'is not null', null)
    return this
  }

  /**
   * Add a WHERE IN condition.
   * @param field - Column to check
   * @param values - Array of values to match against
   */
  whereIn<TKey extends FieldKey<TRecord>>(field: TKey, values: readonly TRecord[TKey][]): this {
    this.addSimpleCondition(field, 'in', values)
    return this
  }

  /**
   * Add a WHERE NOT IN condition.
   * @param field - Column to check
   * @param values - Array of values to exclude
   */
  whereNotIn<TKey extends FieldKey<TRecord>>(field: TKey, values: readonly TRecord[TKey][]): this {
    this.addSimpleCondition(field, 'not in', values)
    return this
  }

  /**
   * Add an ORDER BY clause. Can be called multiple times to sort by multiple columns.
   * @param field - Column to sort by
   * @param direction - Sort direction (default: 'asc')
   */
  orderBy(field: FieldKey<TRecord>, direction: OrderDirection = 'asc'): this {
    this.options.orderBy.push({ column: field, direction })
    return this
  }

  /**
   * Set the maximum number of records to return.
   * @param n - Maximum record count
   */
  limit(n: number): this {
    this.options.limitValue = n
    return this
  }

  /**
   * Set the number of records to skip.
   * @param n - Number of records to skip
   */
  offset(n: number): this {
    this.options.offsetValue = n
    return this
  }

  /**
   * Limit the columns returned in the result.
   * @param fields - Column names to select
   */
  select<TKey extends FieldKey<TRecord>>(...fields: readonly TKey[]): QueryBuilder<TRecord, Pick<TRecord, TKey>> {
    this.options.selectFields = [...fields]
    return this as unknown as QueryBuilder<TRecord, Pick<TRecord, TKey>>
  }

  /**
   * Apply a named query scope defined on the model.
   *
   * @param name - The scope name
   * @returns this (for chaining)
   *
   * @example
   * const results = await Post.where('author', 'John')
   *   .scope('published')
   *   .scope('popular')
   *   .get()
   */
  scope(name: string): this {
    const modelScopes = (this.modelClass as typeof Model & { scopes?: Record<string, (q: QueryBuilder<any>) => QueryBuilder<any>> }).scopes // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!modelScopes || typeof modelScopes[name] !== 'function') {
      throw new Error(`${this.modelClass.name}: unknown scope "${name}".`)
    }
    modelScopes[name](this)
    return this
  }

  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // Eager Loading
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------

  /**
   * Eager-load relationships on query results.
   *
   * Supports string names, arrays, dot notation for nested relations,
   * and constraint callbacks.
   *
   * @example
   * // Simple
   * await User.where('active', true).with('posts').get()
   *
   * // Multiple
   * await User.where('active', true).with('posts', 'comments').get()
   *
   * // Nested (dot notation)
   * await User.where('active', true).with('posts.comments').get()
   */
  with(...relations: (string | Record<string, (q: QueryBuilder<any>) => void>)[]): this { // eslint-disable-line @typescript-eslint/no-explicit-any
    for (const rel of relations) {
      if (typeof rel === 'string') {
        if (!this.eagerLoad.includes(rel)) this.eagerLoad.push(rel)
      } else {
        for (const [name, constraint] of Object.entries(rel)) {
          if (!this.eagerLoad.includes(name)) this.eagerLoad.push(name)
          this.eagerLoadConstraints.set(name, constraint)
        }
      }
    }
    return this
  }

  // ---------------------------------------------------------------------------
  // Terminal methods
  // ---------------------------------------------------------------------------

  /**
   * Execute the query and return all matching records.
   * @returns Array of matching records
   */
  async get(): Promise<TResult[]> {
    const results = await this.executeQuery()
    return this.loadEagerRelations(results)
  }

  /**
   * Execute the query and return the first matching record.
   * @returns The first record or null
   */
  async first(): Promise<TResult | null> {
    const prev = this.options.limitValue
    this.options.limitValue = 1
    const results = await this.executeQuery()
    this.options.limitValue = prev
    if (results.length === 0) return null
    const loaded = await this.loadEagerRelations(results)
    return loaded[0] as TResult
  }

  /**
   * Execute the query and return the first matching record, or throw.
   * @returns The first record
   * @throws ModelNotFoundException (404) if no record matches
   */
  async firstOrFail(): Promise<TResult> {
    const record = await this.first()
    if (record === null) {
      throw new ModelNotFoundException(this.modelClass.name)
    }
    return record
  }

  /**
   * Count the number of records matching the current conditions.
   * @returns The count of matching records
   */
  async count(): Promise<number> {
    if (typeof this.adapter.count === 'function' && this.conditions.length === 0) {
      return this.adapter.count(this.table, undefined, { trx: this.options.trx })
    }

    // For advanced conditions we need to use the advanced adapter method
    const advancedAdapter = this.adapter as ORMAdapterAdvanced
    if (typeof advancedAdapter.countAdvanced === 'function') {
      return advancedAdapter.countAdvanced(this.table, this.conditions, { trx: this.options.trx })
    }

    // Fallback: fetch all and count
    const results = await this.executeQuery()
    return results.length
  }

  /**
   * Paginate the query results.
   *
   * Accepts either positional arguments or the same options object shape as
   * `Model.paginate()` so the two APIs stay interchangeable:
   *
   * @example
   * await Post.where('published', true).paginate(2, 10)
   * await Post.where('published', true).paginate({ page: 2, perPage: 10 })
   */
  async paginate(page?: number, perPage?: number): Promise<PaginatedResult<TResult>>
  async paginate(options: { page?: number; perPage?: number }): Promise<PaginatedResult<TResult>>
  async paginate(
    pageOrOptions: number | { page?: number; perPage?: number } = 1,
    perPageArg = DEFAULT_PAGINATION_SIZE,
  ): Promise<PaginatedResult<TResult>> {
    const page = typeof pageOrOptions === 'object' ? pageOrOptions.page ?? 1 : pageOrOptions
    const perPage = typeof pageOrOptions === 'object' ? pageOrOptions.perPage ?? DEFAULT_PAGINATION_SIZE : perPageArg
    const sanitizedPage = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1
    const sanitizedPerPage = Number.isFinite(perPage) && perPage >= 1 ? Math.floor(perPage) : DEFAULT_PAGINATION_SIZE

    const total = await this.count()
    const totalPages = total === 0 ? 1 : Math.max(1, Math.ceil(total / sanitizedPerPage))
    const currentPage = Math.min(sanitizedPage, totalPages)
    const offset = (currentPage - 1) * sanitizedPerPage

    // Save and override limit/offset for the data query
    const prevLimit = this.options.limitValue
    const prevOffset = this.options.offsetValue
    this.options.limitValue = sanitizedPerPage
    this.options.offsetValue = offset

    const data = await this.executeQuery()

    // Restore
    this.options.limitValue = prevLimit
    this.options.offsetValue = prevOffset

    const from = total === 0 ? 0 : offset + 1
    const to = total === 0 ? 0 : offset + data.length

    const meta: ModelPaginationMeta = {
      total,
      perPage: sanitizedPerPage,
      currentPage,
      totalPages,
      hasMore: currentPage < totalPages,
      from,
      to: Math.min(to, total),
    }

    return { data, meta }
  }

  /**
   * Bulk update records matching the current conditions.
   *
   * Mass-assignment protection applies exactly as in `Model.update()`:
   * with a `fillable` allowlist, out-of-allowlist keys throw a
   * MassAssignmentException. The payload also runs through the same
   * persistence preparation as `Model.update()` — mutators, casts, and
   * `preparePersistencePayload` overrides (e.g. password hashing on
   * authenticatable models). Per-record hooks and observers are still
   * skipped by design.
   *
   * @param data - Data to set on matching records
   * @returns The updated record (adapter-dependent)
   */
  async update(data: PlainObject): Promise<TRecord> {
    return this.runBulkUpdate(data, true)
  }

  /**
   * Bulk update bypassing mass-assignment protection. Use for trusted,
   * server-side-assembled data — never for raw request input.
   */
  async forceUpdate(data: PlainObject): Promise<TRecord> {
    return this.runBulkUpdate(data, false)
  }

  private async runBulkUpdate(data: PlainObject, applyFillable: boolean): Promise<TRecord> {
    const model = this.modelClass as typeof Model
    const filtered = applyFillable ? model.filterFillable(data) : { ...data }
    const payload = await model.prepareBulkPersistencePayload(filtered)
    return this[PREPARED_UPDATE](payload)
  }

  /**
   * Bulk update using a payload the caller has already run through
   * mass-assignment filtering and persistence preparation. This exists so the
   * static `Model.update()` write path can borrow the builder's
   * global-scope-carrying `conditions` without re-preparing the payload —
   * running mutators twice would, for example, double-hash a hashed column.
   *
   * Keyed by a symbol that this package never re-exports, because a named
   * public method here would be a supported way to write arbitrary columns:
   * it skips both `filterFillable` and `prepareBulkPersistencePayload`, so
   * `User.where(…)[name](requestBody)` would bypass mass-assignment protection
   * entirely. `@internal` is only a doc tag — declarations still emit it.
   */
  async [PREPARED_UPDATE](payload: PlainObject): Promise<TRecord> {
    if (!this.adapter.update) {
      throw new Error('Configured adapter does not support update operations.')
    }

    const advancedAdapter = this.adapter as ORMAdapterAdvanced
    if (typeof advancedAdapter.updateAdvanced === 'function') {
      return advancedAdapter.updateAdvanced(this.table, this.conditions, payload, { trx: this.options.trx }) as Promise<TRecord>
    }

    // Fallback to simple where clause if possible
    const simpleWhere = this.toSimpleWhereClause()
    if (simpleWhere) {
      return this.adapter.update(this.table, simpleWhere, payload, { trx: this.options.trx }) as Promise<TRecord>
    }

    throw new Error('Advanced conditions require an adapter that supports updateAdvanced.')
  }

  /**
   * Bulk delete records matching the current conditions.
   * @returns Number of deleted records (adapter-dependent)
   */
  async delete(): Promise<number | PlainObject | void> {
    if (!this.adapter.delete) {
      throw new Error('Configured adapter does not support delete operations.')
    }

    const advancedAdapter = this.adapter as ORMAdapterAdvanced
    if (typeof advancedAdapter.deleteAdvanced === 'function') {
      return advancedAdapter.deleteAdvanced(this.table, this.conditions, { trx: this.options.trx })
    }

    // Fallback to simple where clause if possible
    const simpleWhere = this.toSimpleWhereClause()
    if (simpleWhere) {
      return this.adapter.delete(this.table, simpleWhere, { trx: this.options.trx })
    }

    throw new Error('Advanced conditions require an adapter that supports deleteAdvanced.')
  }

  // ---------------------------------------------------------------------------
  // Thenable implementation
  // ---------------------------------------------------------------------------

  /**
   * Makes QueryBuilder a thenable so it can be directly awaited.
   * Resolves to the result of `get()`.
   */
  then<TResult1 = TResult[], TResult2 = never>(
    onfulfilled?: ((value: TResult[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.get().then(onfulfilled, onrejected)
  }

  /**
   * Catch handler for the thenable interface.
   */
  catch<TCatch = never>(
    onrejected?: ((reason: unknown) => TCatch | PromiseLike<TCatch>) | null,
  ): Promise<TResult[] | TCatch> {
    return this.get().catch(onrejected)
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /** Get the internal conditions (used by adapters). */
  getConditions(): WhereCondition[] {
    return this.conditions
  }

  /** Get the internal query options (used by adapters). */
  getOptions(): QueryBuilderOptions {
    return { ...this.options }
  }

  private addSimpleCondition(field: string, operator: WhereOperator, value: unknown): void {
    this.conditions.push({
      type: 'simple',
      field,
      operator,
      value,
    })
  }

  private async executeQuery(): Promise<TResult[]> {
    const advancedAdapter = this.adapter as ORMAdapterAdvanced

    if (typeof advancedAdapter.findManyAdvanced === 'function') {
      return advancedAdapter.findManyAdvanced<TResult>(this.table, this.conditions, {
        orderBy: this.options.orderBy.length > 0 ? (this.options.orderBy as OrderByClause) : undefined,
        limit: this.options.limitValue,
        offset: this.options.offsetValue,
        select: this.options.selectFields,
      }, { trx: this.options.trx })
    }

    // Fallback: convert to simple where clause if possible. Passing a null
    // conversion on as `where: undefined` would drop every condition — global
    // scopes included — and return the whole table, so refuse instead.
    const simpleWhere = this.toSimpleWhereClause()
    if (simpleWhere === null && this.conditions.length > 0) {
      throw new Error(
        `${this.modelClass.name}: this query uses conditions the configured adapter cannot express `
        + `(it implements neither findManyAdvanced nor countAdvanced). Running it would drop every `
        + `condition, including any global scope, and return unfiltered rows.`,
      )
    }
    return this.adapter.findMany<TResult>(this.table, {
      where: (simpleWhere ?? undefined) as FindManyOptions<TResult>['where'],
      orderBy: this.options.orderBy.length > 0 ? (this.options.orderBy as OrderByClause) : undefined,
      limit: this.options.limitValue,
      offset: this.options.offsetValue,
    }, { trx: this.options.trx })
  }

  /**
   * Attempt to convert the current conditions to a simple WhereClause
   * for backward compatibility with basic adapters.
   * Returns null if conditions are too complex.
   */
  private toSimpleWhereClause(): Record<string, unknown> | null {
    if (this.conditions.length === 0) {
      return null
    }

    const result: Record<string, unknown> = {}

    for (const condition of this.conditions) {
      if (condition.type !== 'simple') {
        return null // Cannot convert OR groups to simple where
      }

      let value: unknown
      if (condition.operator === '=' || condition.operator === 'in') {
        value = condition.value
      } else if (condition.operator === 'is null') {
        value = null
      } else {
        return null // Cannot convert comparison operators to simple where
      }

      // A flat object holds one value per field, so a second condition on the
      // same field would overwrite the first. AND-ing two constraints is not
      // the same as keeping only the later one: a global scope pinning
      // `tenantId` would be replaced by a caller's own `where('tenantId', …)`,
      // handing them another tenant's rows. Only a repeat of the same value is
      // safe to collapse.
      if (condition.field in result && !Object.is(result[condition.field], value)) {
        return null
      }

      result[condition.field] = value
    }

    return result
  }

  /**
   * Load eager relations onto fetched results.
   * Supports dot notation for nested relations at any depth
   * (e.g., 'posts.comments.author') — the full path is delegated to
   * Model.loadRelationInto, which recurses through the relation chain.
   */
  private readonly loadEagerRelations = async (results: TResult[]): Promise<TResult[]> => {
    if (this.eagerLoad.length === 0 || results.length === 0) return results

    const copies = results.map((r) => ({ ...r }))
    const model = this.modelClass as typeof Model & {
      loadRelationInto(records: PlainObject[], name: string): Promise<void>
    }

    for (const relation of this.eagerLoad) {
      await model.loadRelationInto(copies as PlainObject[], relation)
    }

    return copies as TResult[]
  }
}

/**
 * Extended adapter interface for advanced query builder features.
 * Adapters can optionally implement these methods for full QueryBuilder support.
 */
export interface ORMAdapterAdvanced extends ORMAdapter {
  findManyAdvanced?<TRecord extends PlainObject = PlainObject>(
    table: unknown,
    conditions: WhereCondition[],
    options: {
      orderBy?: OrderByClause
      limit?: number
      offset?: number
      select?: readonly string[]
    },
    queryOptions?: AdapterQueryOptions,
  ): Promise<TRecord[]>
  countAdvanced?<TRecord extends PlainObject = PlainObject>(
    table: unknown,
    conditions: WhereCondition[],
    queryOptions?: AdapterQueryOptions,
  ): Promise<number>
  updateAdvanced?<TRecord extends PlainObject = PlainObject>(
    table: unknown,
    conditions: WhereCondition[],
    data: PlainObject,
    writeOptions?: AdapterQueryOptions,
  ): Promise<TRecord>
  deleteAdvanced?<TRecord extends PlainObject = PlainObject>(
    table: unknown,
    conditions: WhereCondition[],
    writeOptions?: AdapterQueryOptions,
  ): Promise<number | PlainObject | void>
}
