import type { TestLifecycleHooks } from './lifecycle'
import { getTestLifecycleHooks } from './lifecycle'

/**
 * Database connection interface for testing.
 */
export interface DatabaseConnection {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>
  execute(sql: string, params?: unknown[]): Promise<void>
  beginTransaction(): Promise<void>
  commit(): Promise<void>
  rollback(): Promise<void>
}

let globalDb: DatabaseConnection | null = null

/**
 * Set the global database connection for testing.
 */
export function setTestDatabase(db: DatabaseConnection): void {
  globalDb = db
}

/**
 * Get the global database connection.
 */
export function getTestDatabase(): DatabaseConnection {
  if (!globalDb) {
    throw new Error(
      'Test database not configured. Call setTestDatabase() first.'
    )
  }
  return globalDb
}

/**
 * Assert database has a record matching the criteria.
 */
export async function assertDatabaseHas(
  table: string,
  data: Record<string, unknown>,
  db?: DatabaseConnection
): Promise<void> {
  const connection = db ?? getTestDatabase()
  const { where, params } = buildWhereClause(data)
  const sql = `SELECT COUNT(*) as count FROM ${table} WHERE ${where}`
  const result = await connection.query<{ count: number }>(sql, params)

  if (!result[0] || result[0].count === 0) {
    throw new Error(
      `Expected database table [${table}] to have record matching ${JSON.stringify(data)}`
    )
  }
}

/**
 * Assert database does not have a record matching the criteria.
 */
export async function assertDatabaseMissing(
  table: string,
  data: Record<string, unknown>,
  db?: DatabaseConnection
): Promise<void> {
  const connection = db ?? getTestDatabase()
  const { where, params } = buildWhereClause(data)
  const sql = `SELECT COUNT(*) as count FROM ${table} WHERE ${where}`
  const result = await connection.query<{ count: number }>(sql, params)

  if (result[0] && result[0].count > 0) {
    throw new Error(
      `Expected database table [${table}] not to have record matching ${JSON.stringify(data)}`
    )
  }
}

/**
 * Assert database table has a specific count.
 */
export async function assertDatabaseCount(
  table: string,
  count: number,
  db?: DatabaseConnection
): Promise<void> {
  const connection = db ?? getTestDatabase()
  const sql = `SELECT COUNT(*) as count FROM ${table}`
  const result = await connection.query<{ count: number }>(sql)

  const actualCount = result[0]?.count ?? 0
  if (actualCount !== count) {
    throw new Error(
      `Expected database table [${table}] to have ${count} records, got ${actualCount}`
    )
  }
}

/**
 * Assert database table is empty.
 */
export async function assertDatabaseEmpty(
  table: string,
  db?: DatabaseConnection
): Promise<void> {
  await assertDatabaseCount(table, 0, db)
}

/**
 * Assert a record is soft deleted (has deleted_at set).
 */
export async function assertSoftDeleted(
  table: string,
  data: Record<string, unknown>,
  deletedAtColumn = 'deleted_at',
  db?: DatabaseConnection
): Promise<void> {
  const connection = db ?? getTestDatabase()
  const { where, params } = buildWhereClause(data)
  const sql = `SELECT ${deletedAtColumn} FROM ${table} WHERE ${where}`
  const result = await connection.query<Record<string, unknown>>(sql, params)

  if (!result[0]) {
    throw new Error(
      `Expected database table [${table}] to have record matching ${JSON.stringify(data)}`
    )
  }

  if (result[0][deletedAtColumn] === null) {
    throw new Error(
      `Expected record in [${table}] to be soft deleted, but ${deletedAtColumn} is null`
    )
  }
}

/**
 * Assert a record is not soft deleted.
 */
export async function assertNotSoftDeleted(
  table: string,
  data: Record<string, unknown>,
  deletedAtColumn = 'deleted_at',
  db?: DatabaseConnection
): Promise<void> {
  const connection = db ?? getTestDatabase()
  const { where, params } = buildWhereClause(data)
  const sql = `SELECT ${deletedAtColumn} FROM ${table} WHERE ${where}`
  const result = await connection.query<Record<string, unknown>>(sql, params)

  if (!result[0]) {
    throw new Error(
      `Expected database table [${table}] to have record matching ${JSON.stringify(data)}`
    )
  }

  if (result[0][deletedAtColumn] !== null) {
    throw new Error(
      `Expected record in [${table}] not to be soft deleted, but ${deletedAtColumn} is set`
    )
  }
}

/**
 * Run each test in a transaction that is rolled back afterwards. Lifecycle hooks are
 * resolved via `getTestLifecycleHooks()` unless passed explicitly.
 */
export function useDatabaseTransactions(
  db?: DatabaseConnection,
  hooks?: TestLifecycleHooks
): void {
  const { beforeEach, afterEach } = hooks ?? getTestLifecycleHooks()

  beforeEach(async () => {
    const connection = db ?? getTestDatabase()
    await connection.beginTransaction()
  })

  afterEach(async () => {
    const connection = db ?? getTestDatabase()
    await connection.rollback()
  })
}

/**
 * Truncate tables before each test. Lifecycle hooks are resolved via
 * `getTestLifecycleHooks()` unless passed explicitly.
 */
export function useTruncateTables(
  tables: string[],
  db?: DatabaseConnection,
  hooks?: TestLifecycleHooks
): void {
  const { beforeEach } = hooks ?? getTestLifecycleHooks()

  beforeEach(async () => {
    const connection = db ?? getTestDatabase()
    for (const table of tables) {
      await connection.execute(`DELETE FROM ${table}`)
    }
  })
}

/**
 * Refresh database (run migrations) before tests.
 */
export async function refreshDatabase(
  migrateFn: () => Promise<void>
): Promise<void> {
  await migrateFn()
}

/**
 * Seed database with data.
 */
export async function seedDatabase(
  seedFn: () => Promise<void>
): Promise<void> {
  await seedFn()
}

function buildWhereClause(data: Record<string, unknown>): {
  where: string
  params: unknown[]
} {
  const conditions: string[] = []
  const params: unknown[] = []

  for (const [key, value] of Object.entries(data)) {
    if (value === null) {
      conditions.push(`${key} IS NULL`)
    } else {
      conditions.push(`${key} = ?`)
      params.push(value)
    }
  }

  return {
    where: conditions.join(' AND '),
    params,
  }
}

/**
 * Database assertion helper class.
 */
export class DatabaseAssertions {
  private db: DatabaseConnection

  constructor(db: DatabaseConnection) {
    this.db = db
  }

  /**
   * Assert database has a record.
   */
  async assertHas(table: string, data: Record<string, unknown>): Promise<void> {
    await assertDatabaseHas(table, data, this.db)
  }

  /**
   * Assert database is missing a record.
   */
  async assertMissing(table: string, data: Record<string, unknown>): Promise<void> {
    await assertDatabaseMissing(table, data, this.db)
  }

  /**
   * Assert database table has count.
   */
  async assertCount(table: string, count: number): Promise<void> {
    await assertDatabaseCount(table, count, this.db)
  }

  /**
   * Assert database table is empty.
   */
  async assertEmpty(table: string): Promise<void> {
    await assertDatabaseEmpty(table, this.db)
  }

  /**
   * Assert record is soft deleted.
   */
  async assertSoftDeleted(
    table: string,
    data: Record<string, unknown>,
    deletedAtColumn = 'deleted_at'
  ): Promise<void> {
    await assertSoftDeleted(table, data, deletedAtColumn, this.db)
  }

  /**
   * Assert record is not soft deleted.
   */
  async assertNotSoftDeleted(
    table: string,
    data: Record<string, unknown>,
    deletedAtColumn = 'deleted_at'
  ): Promise<void> {
    await assertNotSoftDeleted(table, data, deletedAtColumn, this.db)
  }
}

/**
 * Create database assertions helper.
 */
export function createDatabaseAssertions(db: DatabaseConnection): DatabaseAssertions {
  return new DatabaseAssertions(db)
}
