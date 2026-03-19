import type { FindManyOptions, Model, ORMAdapter, OrderByClause, OrderDirection, PaginatedResult, PaginationMeta, PlainObject } from './Model'

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
  selectFields?: string[]
}

const DEFAULT_PAGINATION_SIZE = 15

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
export class QueryBuilder<TRecord extends PlainObject = PlainObject> {
  private conditions: WhereCondition[] = []
  private options: QueryBuilderOptions = { orderBy: [] }
  private modelClass: typeof Model
  private table: unknown
  private adapter: ORMAdapter

  constructor(modelClass: typeof Model) {
    this.modelClass = modelClass
    this.table = (modelClass as unknown as { resolveTable(): unknown }).resolveTable()
    this.adapter = modelClass.getAdapter()
  }

  /**
   * Add a where condition (AND).
   *
   * Supports three calling signatures:
   * - `where(field, value)` - equality check
   * - `where(field, operator, value)` - comparison
   * - `where(object)` - multiple equality conditions
   */
  where(field: string, value: unknown): this
  where(field: string, operator: WhereOperator, value: unknown): this
  where(conditions: Partial<Record<string, unknown>>): this
  where(fieldOrConditions: string | Partial<Record<string, unknown>>, operatorOrValue?: unknown, value?: unknown): this {
    if (typeof fieldOrConditions === 'object' && fieldOrConditions !== null) {
      for (const [key, val] of Object.entries(fieldOrConditions)) {
        if (val !== undefined) {
          this.addSimpleCondition(key, '=', val)
        }
      }
      return this
    }

    const field = fieldOrConditions as string

    if (arguments.length === 2) {
      this.addSimpleCondition(field, '=', operatorOrValue)
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
  orWhere(field: string, value: unknown): this
  orWhere(field: string, operator: WhereOperator, value: unknown): this
  orWhere(conditions: Partial<Record<string, unknown>>): this
  orWhere(fieldOrConditions: string | Partial<Record<string, unknown>>, operatorOrValue?: unknown, value?: unknown): this {
    const orConditions: SimpleCondition[] = []

    if (typeof fieldOrConditions === 'object' && fieldOrConditions !== null) {
      for (const [key, val] of Object.entries(fieldOrConditions)) {
        if (val !== undefined) {
          orConditions.push({ type: 'simple', field: key, operator: '=', value: val })
        }
      }
    } else {
      const field = fieldOrConditions as string

      if (arguments.length === 2) {
        orConditions.push({ type: 'simple', field, operator: '=', value: operatorOrValue })
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
  whereNull(field: string): this {
    this.addSimpleCondition(field, 'is null', null)
    return this
  }

  /**
   * Add a WHERE NOT NULL condition.
   * @param field - Column to check for NOT NULL
   */
  whereNotNull(field: string): this {
    this.addSimpleCondition(field, 'is not null', null)
    return this
  }

  /**
   * Add a WHERE IN condition.
   * @param field - Column to check
   * @param values - Array of values to match against
   */
  whereIn(field: string, values: unknown[]): this {
    this.addSimpleCondition(field, 'in', values)
    return this
  }

  /**
   * Add a WHERE NOT IN condition.
   * @param field - Column to check
   * @param values - Array of values to exclude
   */
  whereNotIn(field: string, values: unknown[]): this {
    this.addSimpleCondition(field, 'not in', values)
    return this
  }

  /**
   * Add an ORDER BY clause. Can be called multiple times to sort by multiple columns.
   * @param field - Column to sort by
   * @param direction - Sort direction (default: 'asc')
   */
  orderBy(field: string, direction: OrderDirection = 'asc'): this {
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
  select(...fields: string[]): this {
    this.options.selectFields = fields
    return this
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
  // Terminal methods
  // ---------------------------------------------------------------------------

  /**
   * Execute the query and return all matching records.
   * @returns Array of matching records
   */
  async get(): Promise<TRecord[]> {
    return this.executeQuery()
  }

  /**
   * Execute the query and return the first matching record.
   * @returns The first record or null
   */
  async first(): Promise<TRecord | null> {
    const prev = this.options.limitValue
    this.options.limitValue = 1
    const results = await this.executeQuery()
    this.options.limitValue = prev
    return (results[0] ?? null) as TRecord | null
  }

  /**
   * Execute the query and return the first matching record, or throw.
   * @returns The first record
   * @throws Error if no record matches
   */
  async firstOrFail(): Promise<TRecord> {
    const record = await this.first()
    if (record === null) {
      throw new Error(`${this.modelClass.name} not found`)
    }
    return record
  }

  /**
   * Count the number of records matching the current conditions.
   * @returns The count of matching records
   */
  async count(): Promise<number> {
    if (typeof this.adapter.count === 'function' && this.conditions.length === 0) {
      return this.adapter.count(this.table)
    }

    // For advanced conditions we need to use the advanced adapter method
    const advancedAdapter = this.adapter as ORMAdapterAdvanced
    if (typeof advancedAdapter.countAdvanced === 'function') {
      return advancedAdapter.countAdvanced(this.table, this.conditions)
    }

    // Fallback: fetch all and count
    const results = await this.executeQuery()
    return results.length
  }

  /**
   * Paginate the query results.
   * @param page - Page number (1-based, default: 1)
   * @param perPage - Records per page (default: 15)
   * @returns Paginated result with data and metadata
   */
  async paginate(page = 1, perPage = DEFAULT_PAGINATION_SIZE): Promise<PaginatedResult<TRecord>> {
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

    const meta: PaginationMeta = {
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
   * @param data - Data to set on matching records
   * @returns The updated record (adapter-dependent)
   */
  async update(data: PlainObject): Promise<TRecord> {
    if (!this.adapter.update) {
      throw new Error('Configured adapter does not support update operations.')
    }

    const advancedAdapter = this.adapter as ORMAdapterAdvanced
    if (typeof advancedAdapter.updateAdvanced === 'function') {
      return advancedAdapter.updateAdvanced(this.table, this.conditions, data) as Promise<TRecord>
    }

    // Fallback to simple where clause if possible
    const simpleWhere = this.toSimpleWhereClause()
    if (simpleWhere) {
      return this.adapter.update(this.table, simpleWhere, data) as Promise<TRecord>
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
      return advancedAdapter.deleteAdvanced(this.table, this.conditions)
    }

    // Fallback to simple where clause if possible
    const simpleWhere = this.toSimpleWhereClause()
    if (simpleWhere) {
      return this.adapter.delete(this.table, simpleWhere)
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
  then<TResult1 = TRecord[], TResult2 = never>(
    onfulfilled?: ((value: TRecord[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.get().then(onfulfilled, onrejected)
  }

  /**
   * Catch handler for the thenable interface.
   */
  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<TRecord[] | TResult> {
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

  private async executeQuery(): Promise<TRecord[]> {
    const advancedAdapter = this.adapter as ORMAdapterAdvanced

    if (typeof advancedAdapter.findManyAdvanced === 'function') {
      return advancedAdapter.findManyAdvanced<TRecord>(this.table, this.conditions, {
        orderBy: this.options.orderBy.length > 0 ? (this.options.orderBy as OrderByClause) : undefined,
        limit: this.options.limitValue,
        offset: this.options.offsetValue,
        select: this.options.selectFields,
      })
    }

    // Fallback: convert to simple where clause if possible
    const simpleWhere = this.toSimpleWhereClause()
    return this.adapter.findMany<TRecord>(this.table, {
      where: (simpleWhere ?? undefined) as FindManyOptions<TRecord>['where'],
      orderBy: this.options.orderBy.length > 0 ? (this.options.orderBy as OrderByClause) : undefined,
      limit: this.options.limitValue,
      offset: this.options.offsetValue,
    })
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

      if (condition.operator === '=') {
        result[condition.field] = condition.value
      } else if (condition.operator === 'in') {
        result[condition.field] = condition.value
      } else if (condition.operator === 'is null') {
        result[condition.field] = null
      } else {
        return null // Cannot convert comparison operators to simple where
      }
    }

    return result
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
      select?: string[]
    },
  ): Promise<TRecord[]>
  countAdvanced?<TRecord extends PlainObject = PlainObject>(
    table: unknown,
    conditions: WhereCondition[],
  ): Promise<number>
  updateAdvanced?<TRecord extends PlainObject = PlainObject>(
    table: unknown,
    conditions: WhereCondition[],
    data: PlainObject,
  ): Promise<TRecord>
  deleteAdvanced?<TRecord extends PlainObject = PlainObject>(
    table: unknown,
    conditions: WhereCondition[],
  ): Promise<number | PlainObject | void>
}
