import { PREPARED_UPDATE, RAW_RESULTS, READ_TRANSFORMS, SEAL_SCOPES } from './internal-keys'
import { DEFAULT_PAGINATION_SIZE } from './Model'
import { ModelNotFoundException } from './ModelNotFoundException'
import { groupConditionSequence } from './where-conditions'
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

export type WhereOperator = '=' | '!=' | '>' | '<' | '>=' | '<=' | 'like' | 'in' | 'not in' | 'is null' | 'is not null'

export interface SimpleCondition {
  type: 'simple'
  field: string
  operator: WhereOperator
  value: unknown
}

export interface GroupCondition {
  type: 'group'
  boolean: 'and' | 'or'
  conditions: WhereCondition[]
}

export type WhereCondition = SimpleCondition | GroupCondition

/**
 * Composes a parenthesized condition group. Only the conditions added on the
 * nested builder are read back — ordering, limits, eager loads and terminal
 * calls made inside the callback are not part of the group.
 */
export type WhereGroupCallback<TRecord extends PlainObject = PlainObject> = (
  query: QueryBuilder<TRecord>,
) => void

export interface QueryBuilderOptions {
  orderBy: Array<{ column: string; direction: OrderDirection }>
  limitValue?: number
  offsetValue?: number
  selectFields?: readonly string[]
  trx?: unknown
}

/**
 * A callback that further constrains the query that fetches an eager-loaded
 * relation. Registered through the object form of {@link QueryBuilder.with}.
 */
export type EagerLoadConstraint = (q: QueryBuilder) => void

/**
 * Constraint callbacks keyed by the relation path they constrain, naming the
 * exact level: `posts` the head, `posts.comments` the leaf.
 */
export type EagerLoadConstraints = ReadonlyMap<string, EagerLoadConstraint>

/**
 * Fluent query builder for the Guren ORM. Thenable, so awaiting a builder
 * resolves to the result of `get()`.
 *
 * @example
 * const active = await User.where('active', true)
 */
export class QueryBuilder<
  TRecord extends PlainObject = PlainObject,
  TResult extends PlainObject = TRecord,
> {
  private conditions: WhereCondition[] = []
  private scopeConditions: WhereCondition[] = []
  /** Fold this up wherever a nested builder's conditions are (pushCallbackGroup). */
  private droppedUndefinedFilters = false
  private options: QueryBuilderOptions = { orderBy: [] }
  private modelClass: typeof Model
  private table: unknown
  private adapter: ORMAdapter
  private eagerLoad: string[] = []
  private eagerLoadConstraints: Map<string, EagerLoadConstraint> = new Map()
  private rawResults = false

  constructor(modelClass: typeof Model, options: { trx?: unknown } = {}) {
    this.modelClass = modelClass
    this.table = modelClass.resolveTable()
    this.adapter = modelClass.getAdapter()
    this.options.trx = options.trx
  }

  /**
   * Add a where condition (AND): `where(field, value)`,
   * `where(field, operator, value)`, `where(object)` for several equality
   * checks, or `where(callback)` for a parenthesized group.
   */
  where(callback: WhereGroupCallback<TRecord>): this
  where<TKey extends FieldKey<TRecord>>(field: TKey, value: TRecord[TKey]): this
  where<TKey extends FieldKey<TRecord>>(field: TKey, operator: WhereOperator, value: unknown): this
  where(conditions: Partial<Record<FieldKey<TRecord>, unknown>>): this
  where(
    fieldOrConditions: FieldKey<TRecord> | Partial<Record<FieldKey<TRecord>, unknown>> | WhereGroupCallback<TRecord>,
    operatorOrValue?: unknown,
    value?: unknown,
  ): this {
    if (typeof fieldOrConditions === 'function') {
      this.pushCallbackGroup(fieldOrConditions, 'and')
      return this
    }

    if (typeof fieldOrConditions === 'object' && fieldOrConditions !== null) {
      this.conditions.push(...this.simpleConditionsFrom(fieldOrConditions))
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
   * Same overloads as `where()`, joined with OR. With a callback the group is
   * parenthesized whole: `(preceding conditions) OR (callback group)`.
   */
  orWhere(callback: WhereGroupCallback<TRecord>): this
  orWhere<TKey extends FieldKey<TRecord>>(field: TKey, value: TRecord[TKey]): this
  orWhere<TKey extends FieldKey<TRecord>>(field: TKey, operator: WhereOperator, value: unknown): this
  orWhere(conditions: Partial<Record<FieldKey<TRecord>, unknown>>): this
  orWhere(
    fieldOrConditions: FieldKey<TRecord> | Partial<Record<FieldKey<TRecord>, unknown>> | WhereGroupCallback<TRecord>,
    operatorOrValue?: unknown,
    value?: unknown,
  ): this {
    if (typeof fieldOrConditions === 'function') {
      this.pushCallbackGroup(fieldOrConditions, 'or')
      return this
    }

    const orConditions: SimpleCondition[] = []

    if (typeof fieldOrConditions === 'object' && fieldOrConditions !== null) {
      orConditions.push(...this.simpleConditionsFrom(fieldOrConditions))
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

  whereNull(field: FieldKey<TRecord>): this {
    this.addSimpleCondition(field, 'is null', null)
    return this
  }

  whereNotNull(field: FieldKey<TRecord>): this {
    this.addSimpleCondition(field, 'is not null', null)
    return this
  }

  whereIn<TKey extends FieldKey<TRecord>>(field: TKey, values: readonly TRecord[TKey][]): this {
    this.addSimpleCondition(field, 'in', values)
    return this
  }

  whereNotIn<TKey extends FieldKey<TRecord>>(field: TKey, values: readonly TRecord[TKey][]): this {
    this.addSimpleCondition(field, 'not in', values)
    return this
  }

  /** Can be called multiple times to sort by multiple columns. */
  orderBy(field: FieldKey<TRecord>, direction: OrderDirection = 'asc'): this {
    this.options.orderBy.push({ column: field, direction })
    return this
  }

  limit(n: number): this {
    this.options.limitValue = n
    return this
  }

  offset(n: number): this {
    this.options.offsetValue = n
    return this
  }

  /**
   * Narrows the row to these columns. The model's accessors are then skipped:
   * one reading a column `fields` left out would fabricate a value from
   * `undefined`. Casts still apply to the columns that are there.
   */
  select<TKey extends FieldKey<TRecord>>(...fields: readonly TKey[]): QueryBuilder<TRecord, Pick<TRecord, TKey>> {
    this.options.selectFields = [...fields]
    return this as unknown as QueryBuilder<TRecord, Pick<TRecord, TKey>>
  }

  /** Apply a named query scope defined on the model. */
  scope(name: string): this {
    const modelScopes = (this.modelClass as typeof Model & { scopes?: Record<string, (q: QueryBuilder<any>) => QueryBuilder<any>> }).scopes // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!modelScopes || typeof modelScopes[name] !== 'function') {
      throw new Error(`${this.modelClass.name}: unknown scope "${name}".`)
    }
    modelScopes[name](this)
    return this
  }

  /**
   * Eager-load relationships by name, dot path, or an object of constraint
   * callbacks, each run after the foreign-key filter on exactly the level its key
   * names. Pitfalls: a top-level `orWhere()` ORs against the foreign-key filter
   * (group it); `select()` must keep the relation's key column or the relation is
   * empty; `limit()` applies to the batched query, not per parent record.
   *
   * A `select()` on *this* builder narrows the row, so the model's accessors
   * are skipped rather than run against columns that are not there.
   */
  with(...relations: (string | Record<string, EagerLoadConstraint>)[]): this {
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

  async get(): Promise<TResult[]> {
    // Eager loads first: a loader matches child rows to their parents on the raw
    // key values, and a cast on either side would stop the two from matching.
    const results = await this.loadEagerRelations(await this.executeQuery())
    if (this.rawResults) return results
    const projected = (this.options.selectFields?.length ?? 0) > 0
    return this.modelClass[READ_TRANSFORMS](results, projected)
  }

  /**
   * Rows as the adapter read them. Symbol-keyed and never re-exported: a named
   * public method here would be a supported way to read past a model's casts.
   */
  [RAW_RESULTS](): this {
    this.rawResults = true
    return this
  }

  async first(): Promise<TResult | null> {
    // Same contract as Model.find(): an evaporated filter would hand back an
    // arbitrary row rather than the "no match" the caller asked about.
    if (this.filtersEvaporated()) return null
    const prev = this.options.limitValue
    this.options.limitValue = 1
    try {
      const results = await this.get()
      return results[0] ?? null
    } finally {
      this.options.limitValue = prev
    }
  }

  /** @throws ModelNotFoundException (404) if no record matches. */
  async firstOrFail(): Promise<TResult> {
    const record = await this.first()
    if (record === null) {
      throw new ModelNotFoundException(this.modelClass.name)
    }
    return record
  }

  async count(): Promise<number> {
    if (typeof this.adapter.count === 'function' && !this.hasConditions()) {
      return this.adapter.count(this.table, undefined, { trx: this.options.trx })
    }

    const advancedAdapter = this.adapter as ORMAdapterAdvanced
    if (typeof advancedAdapter.countAdvanced === 'function') {
      return advancedAdapter.countAdvanced(this.table, this.effectiveConditions(), { trx: this.options.trx })
    }

    const results = await this.executeQuery()
    return results.length
  }

  /**
   * @internal Row count per distinct value of `field`, as one grouped COUNT
   * where the adapter can issue it. The fallback reads only that column.
   */
  async countBy(field: FieldKey<TRecord>): Promise<Map<unknown, number>> {
    const advancedAdapter = this.adapter as ORMAdapterAdvanced
    const counts = new Map<unknown, number>()

    if (typeof advancedAdapter.countByAdvanced === 'function') {
      const rows = await advancedAdapter.countByAdvanced(this.table, field, this.effectiveConditions(), { trx: this.options.trx })
      for (const { key, count } of rows) counts.set(key, count)
      return counts
    }

    const prev = this.options.selectFields
    if (typeof advancedAdapter.findManyAdvanced === 'function') this.options.selectFields = [field]
    try {
      for (const row of await this.executeQuery()) {
        const key = (row as PlainObject)[field]
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
    } finally {
      this.options.selectFields = prev
    }
    return counts
  }

  /**
   * Takes positional arguments or the same options object as
   * `Model.paginate()`, so the two APIs stay interchangeable.
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

    const prevLimit = this.options.limitValue
    const prevOffset = this.options.offsetValue
    this.options.limitValue = sanitizedPerPage
    this.options.offsetValue = offset

    // get() is the one path that also attaches `.with()` relations.
    let data: TResult[]
    try {
      data = await this.get()
    } finally {
      this.options.limitValue = prevLimit
      this.options.offsetValue = prevOffset
    }

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
   * Bulk update. Mass-assignment protection and persistence preparation
   * (mutators, casts, `preparePersistencePayload`) apply exactly as in
   * `Model.update()`; per-record hooks and observers are skipped by design.
   */
  async update(data: PlainObject): Promise<TRecord> {
    return this.runBulkUpdate(data, true)
  }

  /**
   * Bulk update bypassing mass-assignment protection. Trusted server-side data
   * only, never raw request input.
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
   * Bulk update with an already-filtered, already-prepared payload, so
   * `Model.update()` can borrow the builder's global-scope-carrying
   * `conditions` without running mutators twice (double-hashing a hashed
   * column). Symbol-keyed and never re-exported: a named public method here
   * would be a supported way to bypass mass-assignment protection entirely.
   */
  async [PREPARED_UPDATE](payload: PlainObject): Promise<TRecord> {
    if (!this.adapter.update) {
      throw new Error('Configured adapter does not support update operations.')
    }
    this.assertFiltersSurvived('update')

    const advancedAdapter = this.adapter as ORMAdapterAdvanced
    if (typeof advancedAdapter.updateAdvanced === 'function') {
      return advancedAdapter.updateAdvanced(this.table, this.effectiveConditions(), payload, { trx: this.options.trx }) as Promise<TRecord>
    }

    const simpleWhere = this.toSimpleWhereClause()
    if (simpleWhere) {
      return this.adapter.update(this.table, simpleWhere, payload, { trx: this.options.trx }) as Promise<TRecord>
    }

    throw new Error('Advanced conditions require an adapter that supports updateAdvanced.')
  }

  async delete(): Promise<number | PlainObject | void> {
    if (!this.adapter.delete) {
      throw new Error('Configured adapter does not support delete operations.')
    }
    this.assertFiltersSurvived('delete')

    const advancedAdapter = this.adapter as ORMAdapterAdvanced
    if (typeof advancedAdapter.deleteAdvanced === 'function') {
      return advancedAdapter.deleteAdvanced(this.table, this.effectiveConditions(), { trx: this.options.trx })
    }

    const simpleWhere = this.toSimpleWhereClause()
    if (simpleWhere) {
      return this.adapter.delete(this.table, simpleWhere, { trx: this.options.trx })
    }

    throw new Error('Advanced conditions require an adapter that supports deleteAdvanced.')
  }

  /** Makes the builder awaitable, resolving to `get()`. */
  then<TResult1 = TResult[], TResult2 = never>(
    onfulfilled?: ((value: TResult[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.get().then(onfulfilled, onrejected)
  }

  catch<TCatch = never>(
    onrejected?: ((reason: unknown) => TCatch | PromiseLike<TCatch>) | null,
  ): Promise<TResult[] | TCatch> {
    return this.get().catch(onrejected)
  }

  getConditions(): WhereCondition[] {
    return this.effectiveConditions()
  }

  /**
   * Freezes the conditions applied so far as this model's global scopes, to be
   * AND-ed around the caller's expression from here on. Left in the same list,
   * a top-level `orWhere()` folds them into its left arm (see
   * `normalizeConditionSequence`) and the query loses tenant isolation and
   * soft-delete filtering.
   */
  [SEAL_SCOPES](): this {
    this.scopeConditions.push(...this.conditions)
    this.conditions = []
    return this
  }

  getOptions(): QueryBuilderOptions {
    return { ...this.options }
  }

  /**
   * The nested builder skips global scopes on purpose: the outer builder
   * already carries them, and re-applying them inside every group would
   * duplicate — or, inside an OR group, weaken — their filters.
   */
  private pushCallbackGroup(callback: WhereGroupCallback<TRecord>, boolean: 'and' | 'or'): void {
    const nested = new QueryBuilder<TRecord>(this.modelClass, { trx: this.options.trx })
    callback(nested)
    // The flag has to outlive the nested builder: a group whose every filter
    // evaporated pushes no node at all, and the write guard would see nothing.
    this.droppedUndefinedFilters ||= nested.droppedUndefinedFilters
    const grouped = groupConditionSequence(nested.conditions, boolean)
    if (grouped) this.conditions.push(grouped)
  }

  private simpleConditionsFrom(criteria: Record<string, unknown>): SimpleCondition[] {
    const conditions: SimpleCondition[] = []
    for (const [field, value] of Object.entries(criteria)) {
      if (value === undefined) {
        this.droppedUndefinedFilters = true
        continue
      }
      // Array values mean IN — mirrors the adapter's object-where contract
      conditions.push({ type: 'simple', field, operator: Array.isArray(value) ? 'in' : '=', value })
    }
    return conditions
  }

  private hasConditions(): boolean {
    return this.scopeConditions.length > 0 || this.conditions.length > 0
  }

  /** Flat list, for the basic-adapter conversion that cannot read group nodes. */
  private allConditions(): WhereCondition[] {
    return this.scopeConditions.length === 0 ? this.conditions : [...this.scopeConditions, ...this.conditions]
  }

  /** Global scopes AND the caller's expression, never folded into it. */
  private effectiveConditions(): WhereCondition[] {
    if (this.scopeConditions.length === 0) return this.conditions
    const caller = groupConditionSequence(this.conditions)
    return caller ? [...this.scopeConditions, caller] : [...this.scopeConditions]
  }

  /**
   * `where({})` and a deliberately unfiltered builder are untouched: only a
   * filter the caller wrote and then lost counts.
   */
  private filtersEvaporated(): boolean {
    return this.droppedUndefinedFilters && this.conditions.length === 0
  }

  private assertFiltersSurvived(operation: 'update' | 'delete'): void {
    if (!this.filtersEvaporated()) return
    throw new Error(
      `${this.modelClass.name}: refusing to ${operation} unfiltered — every value in the where clause was undefined.`,
    )
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
      return advancedAdapter.findManyAdvanced<TResult>(this.table, this.effectiveConditions(), {
        orderBy: this.options.orderBy.length > 0 ? (this.options.orderBy as OrderByClause) : undefined,
        limit: this.options.limitValue,
        offset: this.options.offsetValue,
        select: this.options.selectFields,
      }, { trx: this.options.trx })
    }

    // Passing a null conversion on as `where: undefined` would drop every
    // condition — global scopes included — and return the whole table.
    const simpleWhere = this.toSimpleWhereClause()
    if (simpleWhere === null && this.hasConditions()) {
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

  /** Null when the conditions are too complex for a basic adapter's WhereClause. */
  private toSimpleWhereClause(): Record<string, unknown> | null {
    const conditions = this.allConditions()
    if (conditions.length === 0) {
      return null
    }

    const result: Record<string, unknown> = {}

    for (const condition of conditions) {
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
      // same field would overwrite the first: a global scope pinning
      // `tenantId` replaced by a caller's own `where('tenantId', …)` hands them
      // another tenant's rows. Only a repeat of the same value collapses.
      if (condition.field in result && !Object.is(result[condition.field], value)) {
        return null
      }

      result[condition.field] = value
    }

    return result
  }

  /**
   * Paths are delegated to Model.loadRelationsInto, which recurses the
   * relation chain. The builder's `trx` goes with them: a relation read off
   * the pool while its parents came from an open transaction gets a null
   * relation back on Postgres/MySQL, the parents being uncommitted.
   */
  private readonly loadEagerRelations = async (results: TResult[]): Promise<TResult[]> => {
    if (this.eagerLoad.length === 0 || results.length === 0) return results

    const copies = results.map((r) => ({ ...r }))

    // Every path goes in at once so the loader can group them by head.
    await this.modelClass.loadRelationsInto(
      copies as PlainObject[],
      this.eagerLoad,
      { trx: this.options.trx },
      this.eagerLoadConstraints,
    )

    return copies as TResult[]
  }
}

/** Optional adapter methods needed for full QueryBuilder support. */
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
  // oxlint-disable-next-line no-unused-vars -- phantom type parameter, kept because it is part of the public signature
  countAdvanced?<TRecord extends PlainObject = PlainObject>(
    table: unknown,
    conditions: WhereCondition[],
    queryOptions?: AdapterQueryOptions,
  ): Promise<number>
  /** `SELECT field, COUNT(*) ... GROUP BY field` under `conditions`. */
  countByAdvanced?(
    table: unknown,
    field: string,
    conditions: WhereCondition[],
    queryOptions?: AdapterQueryOptions,
  ): Promise<Array<{ key: unknown; count: number }>>
  updateAdvanced?<TRecord extends PlainObject = PlainObject>(
    table: unknown,
    conditions: WhereCondition[],
    data: PlainObject,
    writeOptions?: AdapterQueryOptions,
  ): Promise<TRecord>
  // oxlint-disable-next-line no-unused-vars -- phantom type parameter, kept because it is part of the public signature
  deleteAdvanced?<TRecord extends PlainObject = PlainObject>(
    table: unknown,
    conditions: WhereCondition[],
    writeOptions?: AdapterQueryOptions,
  ): Promise<number | PlainObject | void>
}
