import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm'
import type { AnyColumn } from 'drizzle-orm'
import type { FindManyOptions, OrderByClause, ORMAdapter, PlainObject, WhereClause } from '../Model'

type DrizzleLikeSelect = {
  where?: (clause: unknown) => DrizzleLikeSelect
  orderBy?: (...clauses: unknown[]) => DrizzleLikeSelect
  all?: () => Promise<unknown[]>
  get?: () => Promise<unknown>
}

type DrizzleLikeInsert = {
  values: (record: PlainObject) => DrizzleLikeInsertResult
}

type DrizzleLikeInsertResult = {
  returning?: () => Promise<unknown[]>
  run?: () => Promise<unknown>
}

type DrizzleLikeUpdate = {
  set: (record: PlainObject) => DrizzleLikeUpdate
  where: (clause: unknown) => DrizzleLikeUpdate
  returning?: () => Promise<unknown[]>
}

type DrizzleLikeDelete = {
  where: (clause: unknown) => DrizzleLikeDelete
  returning?: () => Promise<unknown[]>
  run?: () => Promise<unknown>
}

type DrizzleDatabase = {
  select(): { from(table: unknown): DrizzleLikeSelect }
  insert(table: unknown): DrizzleLikeInsert
  update?(table: unknown): DrizzleLikeUpdate
  delete?(table: unknown): DrizzleLikeDelete
}

let database: DrizzleDatabase | undefined

function ensureDatabase(): DrizzleDatabase {
  if (!database) {
    throw new Error('DrizzleAdapter: database has not been configured. Call DrizzleAdapter.configure(db).')
  }

  return database
}

async function resolveList(result: DrizzleLikeSelect): Promise<unknown[]> {
  if (isPromiseLike(result)) {
    return result as unknown as Promise<unknown[]>
  }

  if (typeof result.all === 'function') {
    return result.all()
  }

  if (typeof result.get === 'function') {
    const item = await result.get()
    return item ? [item] : []
  }

  return []
}

type DrizzleTableLike = Record<string, unknown>

function resolveWhere(table: unknown, where?: WhereClause): unknown {
  if (!where || typeof where !== 'object') {
    return where
  }

  const tableRecord = table as DrizzleTableLike
  const clauses = Object.entries(where)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      const column = tableRecord[key] as AnyColumn | undefined

      if (!column) {
        throw new Error(`DrizzleAdapter: unknown column "${key}" on provided table.`)
      }

      if (Array.isArray(value)) {
        return inArray(column, value)
      }

      if (value === null) {
        return isNull(column)
      }

      return eq(column, value)
    })
    .filter(Boolean)

  if (clauses.length === 0) {
    return undefined
  }

  if (clauses.length === 1) {
    return clauses[0]
  }

  return and(...clauses)
}

function resolveOrder(table: unknown, orderBy?: OrderByClause): unknown[] | undefined {
  if (!orderBy || orderBy.length === 0) {
    return undefined
  }

  const tableRecord = table as DrizzleTableLike
  return orderBy.map(({ column, direction }) => {
    const columnRef = tableRecord[column] as AnyColumn | undefined

    if (!columnRef) {
      throw new Error(`DrizzleAdapter: unknown column "${column}" on provided table.`)
    }

    return direction === 'desc' ? desc(columnRef) : asc(columnRef)
  })
}

async function resolveSingle(result: DrizzleLikeSelect): Promise<unknown | null> {
  if (isPromiseLike(result)) {
    const list = (await (result as unknown as Promise<unknown[]>)) ?? []
    return Array.isArray(list) ? list[0] ?? null : (list ?? null)
  }

  if (typeof result.get === 'function') {
    const item = await result.get()
    return item ?? null
  }

  if (typeof result.all === 'function') {
    const list = await result.all()
    return list[0] ?? null
  }

  return null
}

async function resolveMutation(result: DrizzleLikeInsertResult | DrizzleLikeUpdate | DrizzleLikeDelete): Promise<unknown> {
  if (isPromiseLike(result)) {
    return result as unknown as Promise<unknown>
  }

  if ('returning' in result && typeof result.returning === 'function') {
    const rows = await result.returning()
    return Array.isArray(rows) ? rows[0] ?? rows : rows
  }

  if ('run' in result && typeof result.run === 'function') {
    return result.run()
  }

  return result
}

function isPromiseLike<T>(value: unknown): value is Promise<T> {
  return typeof value === 'object' && value !== null && 'then' in value && typeof (value as { then: unknown }).then === 'function'
}

export const DrizzleAdapter: ORMAdapter & { configure(db: DrizzleDatabase): void } = {
  configure(db: DrizzleDatabase) {
    database = db
  },

  async findMany<TRecord extends PlainObject = PlainObject>(
    table: unknown,
    options?: FindManyOptions<TRecord>,
  ): Promise<TRecord[]> {
    const db = ensureDatabase()
    let query = db.select().from(table)
    const { where, orderBy } = options ?? {}

    if (typeof query.where === 'function') {
      const clause = resolveWhere(table, where)
      if (clause) {
        query = query.where(clause) as DrizzleLikeSelect
      }
    }

    if (typeof query.orderBy === 'function') {
      const clauses = resolveOrder(table, orderBy as OrderByClause)
      if (clauses && clauses.length > 0) {
        query = query.orderBy(...clauses) as DrizzleLikeSelect
      }
    }

    const rows = await resolveList(query)
    return rows as TRecord[]
  },

  async findUnique<TRecord extends PlainObject = PlainObject>(table: unknown, where: WhereClause<TRecord>): Promise<TRecord | null> {
    const db = ensureDatabase()
    let query = db.select().from(table)

    if (typeof query.where === 'function') {
      const clause = resolveWhere(table, where)
      if (clause) {
        query = query.where(clause) as DrizzleLikeSelect
      }
    }

    const row = await resolveSingle(query)
    if (row == null) {
      return null
    }

    return row as TRecord
  },

  async create<TRecord = PlainObject>(table: unknown, data: PlainObject): Promise<TRecord> {
    const db = ensureDatabase()
    const result = await resolveMutation(db.insert(table).values(data))
    return result as TRecord
  },

  async update<TRecord extends PlainObject = PlainObject>(table: unknown, where: WhereClause<TRecord>, data: PlainObject): Promise<TRecord> {
    const db = ensureDatabase()
    if (!db.update) {
      throw new Error('DrizzleAdapter: configured database does not support updates.')
    }

    const clause = resolveWhere(table, where)
    const query = db.update(table).set(data)
    const result = await resolveMutation(clause ? query.where(clause) : query)
    return result as TRecord
  },

  async delete<TRecord extends PlainObject = PlainObject>(table: unknown, where: WhereClause<TRecord>): Promise<number | PlainObject | void> {
    const db = ensureDatabase()
    if (!db.delete) {
      throw new Error('DrizzleAdapter: configured database does not support deletes.')
    }

    const clause = resolveWhere(table, where)
    const query = db.delete(table)
    const result = await resolveMutation(clause ? query.where(clause) : query)
    return result as number | PlainObject | void
  },
}
