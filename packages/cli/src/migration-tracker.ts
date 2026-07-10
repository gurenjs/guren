import { readdir, readFile } from 'node:fs/promises'
import { resolve, basename } from 'node:path'
import { consola } from 'consola'

/**
 * Migration record stored in the database.
 */
export interface MigrationRecord {
  id: number
  name: string
  batch: number
  executed_at: Date
}

/**
 * Migration file info.
 */
export interface MigrationFile {
  name: string
  upPath: string
  downPath: string | null
  hasDownMigration: boolean
}

/**
 * SQL executor interface.
 * The application must provide this to execute SQL statements.
 */
export interface SqlExecutor {
  /**
   * Execute a single SQL statement.
   */
  execute(sql: string): Promise<void>

  /**
   * Query the database and return rows.
   */
  query<T = unknown>(sql: string): Promise<T[]>
}

/**
 * Create the migrations tracking table if it doesn't exist.
 */
export async function ensureMigrationTable(executor: SqlExecutor): Promise<void> {
  const sql = `
    CREATE TABLE IF NOT EXISTS "_guren_migrations" (
      "id" SERIAL PRIMARY KEY,
      "name" TEXT NOT NULL UNIQUE,
      "batch" INTEGER NOT NULL,
      "executed_at" TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `
  await executor.execute(sql)
}

/**
 * Get all applied migrations from the database.
 */
export async function getAppliedMigrations(executor: SqlExecutor): Promise<MigrationRecord[]> {
  const rows = await executor.query<MigrationRecord>(
    `SELECT * FROM "_guren_migrations" ORDER BY "batch" DESC, "id" DESC`
  )
  return rows
}

/**
 * Get the last batch number.
 */
export async function getLastBatch(executor: SqlExecutor): Promise<number> {
  const rows = await executor.query<{ max: number | null }>(
    `SELECT MAX("batch") as max FROM "_guren_migrations"`
  )
  return rows[0]?.max ?? 0
}

/**
 * Escape a value for use inside a single-quoted SQL string literal.
 * The SqlExecutor interface only accepts raw SQL strings, so values must
 * be escaped before interpolation.
 */
function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''")
}

function assertInteger(value: number, label: string): void {
  if (!Number.isInteger(value)) {
    throw new Error(`Migration tracker: ${label} must be an integer, got "${value}".`)
  }
}

/**
 * Record a migration as applied.
 */
export async function recordMigration(
  executor: SqlExecutor,
  name: string,
  batch: number
): Promise<void> {
  assertInteger(batch, 'batch')
  await executor.execute(
    `INSERT INTO "_guren_migrations" ("name", "batch") VALUES ('${escapeSqlString(name)}', ${batch})`
  )
}

/**
 * Remove a migration record.
 */
export async function removeMigrationRecord(
  executor: SqlExecutor,
  name: string
): Promise<void> {
  await executor.execute(
    `DELETE FROM "_guren_migrations" WHERE "name" = '${escapeSqlString(name)}'`
  )
}

/**
 * Get migrations from the last batch.
 */
export async function getLastBatchMigrations(executor: SqlExecutor): Promise<MigrationRecord[]> {
  const lastBatch = await getLastBatch(executor)
  if (lastBatch === 0) {
    return []
  }
  assertInteger(lastBatch, 'batch')

  const rows = await executor.query<MigrationRecord>(
    `SELECT * FROM "_guren_migrations" WHERE "batch" = ${lastBatch} ORDER BY "id" DESC`
  )
  return rows
}

/**
 * Scan the migrations directory for migration files.
 */
export async function scanMigrationFiles(migrationsDir: string): Promise<MigrationFile[]> {
  const files = await readdir(migrationsDir)
  const migrationFiles = new Map<string, MigrationFile>()

  // Sort files to process them in order
  files.sort()

  for (const file of files) {
    // Match migration files: XXXX_name.sql or XXXX_name.down.sql
    const downMatch = file.match(/^(\d+_.+)\.down\.sql$/)
    const upMatch = file.match(/^(\d+_.+)\.sql$/)

    if (downMatch) {
      const name = downMatch[1]
      const existing = migrationFiles.get(name)
      if (existing) {
        existing.downPath = resolve(migrationsDir, file)
        existing.hasDownMigration = true
      } else {
        migrationFiles.set(name, {
          name,
          upPath: resolve(migrationsDir, `${name}.sql`),
          downPath: resolve(migrationsDir, file),
          hasDownMigration: true,
        })
      }
    } else if (upMatch && !file.endsWith('.down.sql')) {
      const name = upMatch[1]
      const existing = migrationFiles.get(name)
      if (!existing) {
        migrationFiles.set(name, {
          name,
          upPath: resolve(migrationsDir, file),
          downPath: null,
          hasDownMigration: false,
        })
      }
    }
  }

  return Array.from(migrationFiles.values()).sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Read migration SQL content.
 */
export async function readMigrationSql(path: string): Promise<string> {
  return readFile(path, 'utf-8')
}

/**
 * Rollback options.
 */
export interface RollbackOptions {
  /**
   * Number of migrations to rollback.
   * @default 1
   */
  steps?: number

  /**
   * Rollback the entire last batch instead of individual migrations.
   * @default false
   */
  batch?: boolean

  /**
   * Skip confirmation prompt.
   * @default false
   */
  force?: boolean

  /**
   * Migrations directory path.
   * @default 'db/migrations'
   */
  migrationsDir?: string
}

/**
 * Rollback database migrations.
 */
export async function rollbackMigrations(
  executor: SqlExecutor,
  options: RollbackOptions = {}
): Promise<string[]> {
  const migrationsDir = options.migrationsDir ?? resolve(process.cwd(), 'db/migrations')
  const steps = options.steps ?? 1
  const useBatch = options.batch ?? false

  // Ensure migrations table exists
  await ensureMigrationTable(executor)

  // Get applied migrations
  let migrationsToRollback: MigrationRecord[]

  if (useBatch) {
    migrationsToRollback = await getLastBatchMigrations(executor)
  } else {
    const allMigrations = await getAppliedMigrations(executor)
    migrationsToRollback = allMigrations.slice(0, steps)
  }

  if (migrationsToRollback.length === 0) {
    return []
  }

  // Get migration files
  const migrationFiles = await scanMigrationFiles(migrationsDir)
  const filesByName = new Map(migrationFiles.map((f) => [f.name, f]))

  const rolledBack: string[] = []

  for (const migration of migrationsToRollback) {
    const file = filesByName.get(migration.name)

    if (!file) {
      consola.warn(`Migration file not found for: ${migration.name}`)
      continue
    }

    if (!file.hasDownMigration || !file.downPath) {
      throw new Error(
        `No down migration found for: ${migration.name}. ` +
        `Create a file named ${migration.name}.down.sql to enable rollback.`
      )
    }

    // Read and execute down migration
    const downSql = await readMigrationSql(file.downPath)

    consola.info(`Rolling back: ${migration.name}`)
    await executor.execute(downSql)

    // Remove migration record
    await removeMigrationRecord(executor, migration.name)
    rolledBack.push(migration.name)
  }

  return rolledBack
}

/**
 * Get migration status.
 */
export interface MigrationStatus {
  name: string
  applied: boolean
  batch: number | null
  executedAt: Date | null
  hasDownMigration: boolean
}

/**
 * Get the status of all migrations.
 */
export async function getMigrationStatus(
  executor: SqlExecutor,
  migrationsDir?: string
): Promise<MigrationStatus[]> {
  const dir = migrationsDir ?? resolve(process.cwd(), 'db/migrations')

  // Ensure migrations table exists
  await ensureMigrationTable(executor)

  // Get all migration files
  const files = await scanMigrationFiles(dir)

  // Get applied migrations
  const applied = await getAppliedMigrations(executor)
  const appliedByName = new Map(applied.map((m) => [m.name, m]))

  return files.map((file) => {
    const record = appliedByName.get(file.name)
    return {
      name: file.name,
      applied: !!record,
      batch: record?.batch ?? null,
      executedAt: record?.executed_at ?? null,
      hasDownMigration: file.hasDownMigration,
    }
  })
}
