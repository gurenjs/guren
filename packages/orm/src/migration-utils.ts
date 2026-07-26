import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Returns true when the folder contains drizzle-kit generated migrations
 * (subdirectories with a migration.sql file).
 */
export function hasDrizzleMigrations(migrationsFolder: string): boolean {
  if (!existsSync(migrationsFolder)) {
    return false
  }

  const entries = readdirSync(migrationsFolder, { withFileTypes: true })
  return entries.some(
    (entry) => entry.isDirectory() && existsSync(resolve(migrationsFolder, entry.name, 'migration.sql')),
  )
}

/**
 * Warns when the migrations folder contains loose .sql files, which the
 * drizzle migrator does not execute. Without this, `db:migrate` reports
 * success while silently skipping them.
 */
export function warnIgnoredFlatSqlMigrations(migrationsFolder: string): void {
  if (!existsSync(migrationsFolder)) {
    return
  }

  const flatSqlFiles = readdirSync(migrationsFolder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)

  if (flatSqlFiles.length > 0) {
    console.warn(
      `[guren/orm] Ignoring ${flatSqlFiles.length} loose .sql file(s) in ${migrationsFolder}: ${flatSqlFiles.join(', ')}.\n` +
      '[guren/orm] Migrations must be generated with drizzle-kit (`bun run db:make`), which creates one folder per migration.',
    )
  }
}

/** Driver error codes that mean the server was never reached. */
const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
  'CONNECT_TIMEOUT',
])

/** Walks the cause chain (and AggregateError members) collecting every nested error. */
function collectCauses(error: unknown, seen = new Set<unknown>()): unknown[] {
  if (error == null || typeof error !== 'object' || seen.has(error)) {
    return []
  }
  seen.add(error)

  const nested = [
    ...(Array.isArray((error as { errors?: unknown }).errors) ? ((error as { errors: unknown[] }).errors) : []),
    ...('cause' in error ? [(error as { cause: unknown }).cause] : []),
  ]

  return [error, ...nested.flatMap((child) => collectCauses(child, seen))]
}

/**
 * Turns a migration failure into a message that names the actual problem.
 *
 * Drizzle wraps driver failures in a DrizzleQueryError whose message is the SQL
 * it was running — for a fresh database that is `CREATE SCHEMA IF NOT EXISTS
 * "drizzle"`, the migrator's own bookkeeping statement. Reporting only that
 * message blames a statement the user never wrote for what is usually an
 * unreachable server (postgres-js reports `ECONNREFUSED` on `cause` and leaves
 * that error's message empty) or a SQL error whose text also lives on `cause`.
 *
 * `endpoint` is included only as host:port / filename — never the connection
 * string, which carries credentials.
 */
export function describeMigrationFailure(error: unknown, endpoint?: string): string {
  const causes = collectCauses(error)

  const connectionCode = causes
    .map((cause) => (cause as { code?: unknown }).code)
    .find((code): code is string => typeof code === 'string' && CONNECTION_ERROR_CODES.has(code))

  if (connectionCode) {
    const target = endpoint ? `the database at ${endpoint}` : 'the database'
    return `cannot connect to ${target} (${connectionCode}). Is it running and accepting connections?`
  }

  const messages: string[] = []
  for (const cause of causes) {
    const message = (cause as { message?: unknown }).message
    if (typeof message === 'string' && message.trim() !== '' && !messages.includes(message)) {
      messages.push(message)
    }
  }

  if (messages.length === 0) {
    return error instanceof Error ? error.message : String(error)
  }

  return messages.join(' — ')
}

/**
 * Reduces a connection string to host:port for error messages, dropping the
 * credentials it embeds. Returns undefined when the value does not parse.
 */
export function describeConnectionEndpoint(connectionString: string): string | undefined {
  try {
    const { hostname, port } = new URL(connectionString)
    if (!hostname) return undefined
    return port ? `${hostname}:${port}` : hostname
  } catch {
    return undefined
  }
}

export interface LocalMigrationEntry {
  /** Folder name, e.g. 20260710221915_create_users_table */
  name: string
}

/**
 * Lists drizzle-kit generated migrations (one folder per migration, each
 * containing migration.sql), sorted the same way the drizzle migrator
 * applies them.
 */
export function listLocalMigrations(migrationsFolder: string): LocalMigrationEntry[] {
  if (!existsSync(migrationsFolder)) {
    return []
  }

  return readdirSync(migrationsFolder, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(resolve(migrationsFolder, entry.name, 'migration.sql')))
    .map((entry) => ({ name: entry.name }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export interface AppliedMigrationRow {
  name: string | null
  appliedAt: string | Date | null
}

export interface MigrationStatusEntry {
  name: string
  applied: boolean
  appliedAt: Date | null
}

/**
 * Joins local migration folders with the rows the drizzle migrator recorded
 * in its tracker table. Drizzle itself decides pending migrations by name
 * membership, so status uses the same rule.
 */
export function buildMigrationStatus(
  localMigrations: LocalMigrationEntry[],
  appliedRows: AppliedMigrationRow[],
): MigrationStatusEntry[] {
  const appliedByName = new Map<string, AppliedMigrationRow>()
  for (const row of appliedRows) {
    if (row.name) {
      appliedByName.set(row.name, row)
    }
  }

  return localMigrations.map((migration) => {
    const row = appliedByName.get(migration.name)
    let appliedAt: Date | null = null
    if (row?.appliedAt) {
      const parsed = row.appliedAt instanceof Date ? row.appliedAt : new Date(row.appliedAt)
      appliedAt = Number.isNaN(parsed.getTime()) ? null : parsed
    }

    return {
      name: migration.name,
      applied: row !== undefined,
      appliedAt,
    }
  })
}
