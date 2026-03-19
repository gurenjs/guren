import { resolve } from 'node:path'
import { consola } from 'consola'
import {
  rollbackMigrations,
  getMigrationStatus,
  type SqlExecutor,
  type RollbackOptions,
} from './migration-tracker'
import { resolveDatabaseModule } from './db-migrate'

type DbObject = Record<string, unknown>
type ExecutorAdapter = (db: DbObject) => SqlExecutor | null

const isSqlExecutor = (db: DbObject): db is DbObject & SqlExecutor =>
  typeof db.execute === 'function' && typeof db.query === 'function'

const DB_ADAPTERS: ExecutorAdapter[] = [
  // Direct execute/query methods
  (db) => (isSqlExecutor(db) ? db : null),
  // Drizzle-style db with execute method
  (db) => typeof db.execute === 'function' ? {
    execute: async (sql: string) => {
      await (db.execute as (s: { sql: string }) => Promise<unknown>)({ sql })
    },
    query: async <T>(sql: string): Promise<T[]> => {
      const result = await (db.execute as (s: { sql: string }) => Promise<{ rows: T[] }>)({ sql })
      return result.rows
    },
  } : null,
  // Raw SQL client with sql() or query()
  (db) => {
    const queryFn = (db.sql ?? db.query) as ((sql: string) => Promise<unknown>) | undefined
    if (typeof queryFn !== 'function') return null
    return {
      execute: async (sql: string) => { await queryFn(sql) },
      query: async <T>(sql: string): Promise<T[]> => {
        const result = (await queryFn(sql)) as T[] | { rows: T[] }
        return Array.isArray(result) ? result : result.rows
      },
    }
  },
]

function createExecutor(db: unknown): SqlExecutor {
  if (typeof db !== 'object' || db === null) {
    throw new Error('getDatabase() must return a database object.')
  }
  for (const adapter of DB_ADAPTERS) {
    const executor = adapter(db as DbObject)
    if (executor) return executor
  }
  throw new Error('Database object must have execute() and query() methods or sql() method.')
}

/**
 * Get SQL executor from the database module.
 */
async function getSqlExecutor(): Promise<{ executor: SqlExecutor; close?: () => Promise<void> }> {
  const module = await resolveDatabaseModule()

  const getDatabase =
    module.getDatabase ||
    module.getSqlExecutor ||
    module.getDb ||
    (module.default as DbObject)?.getDatabase

  if (typeof getDatabase !== 'function') {
    throw new Error(
      'config/database.ts must export getDatabase() that returns { execute(sql), query(sql) } methods.'
    )
  }

  const db = await (getDatabase as () => Promise<unknown>)()
  const executor = createExecutor(db)

  const closeDatabase =
    module.closeDatabase ||
    module.close ||
    (module.default as DbObject)?.closeDatabase

  return {
    executor,
    close: typeof closeDatabase === 'function' ? closeDatabase as () => Promise<void> : undefined,
  }
}

/**
 * Run database rollback.
 */
export async function runDatabaseRollback(options: RollbackOptions = {}): Promise<void> {
  const { executor, close } = await getSqlExecutor()

  try {
    const migrationsDir = options.migrationsDir ?? resolve(process.cwd(), 'db/migrations')

    const rolledBack = await rollbackMigrations(executor, {
      ...options,
      migrationsDir,
    })

    if (rolledBack.length === 0) {
      consola.info('Nothing to rollback.')
    } else {
      consola.success(`Rolled back ${rolledBack.length} migration(s):`)
      for (const name of rolledBack) {
        consola.info(`  - ${name}`)
      }
    }
  } finally {
    if (close) {
      await close()
    }
  }
}

/**
 * Show migration status.
 */
export async function showMigrationStatus(): Promise<void> {
  const { executor, close } = await getSqlExecutor()

  try {
    const migrationsDir = resolve(process.cwd(), 'db/migrations')
    const status = await getMigrationStatus(executor, migrationsDir)

    if (status.length === 0) {
      consola.info('No migrations found.')
      return
    }

    console.log('')
    console.log('  Migration Status')
    console.log('  ─────────────────────────────────────────────────────────────')

    for (const migration of status) {
      const statusIcon = migration.applied ? '✓' : '○'
      const statusColor = migration.applied ? '\x1b[32m' : '\x1b[33m'
      const resetColor = '\x1b[0m'
      const downIcon = migration.hasDownMigration ? '↓' : ' '

      let info = ''
      if (migration.applied) {
        info = ` (batch ${migration.batch})`
      }

      console.log(`  ${statusColor}${statusIcon}${resetColor} ${downIcon} ${migration.name}${info}`)
    }

    console.log('')
    console.log('  Legend: ✓ = applied, ○ = pending, ↓ = has down migration')
    console.log('')

    const applied = status.filter((s) => s.applied).length
    const pending = status.filter((s) => !s.applied).length
    const withDown = status.filter((s) => s.hasDownMigration).length

    console.log(`  Total: ${status.length} | Applied: ${applied} | Pending: ${pending} | With down: ${withDown}`)
    console.log('')
  } finally {
    if (close) {
      await close()
    }
  }
}
