import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * What one `migrateDatabase()` call had to work with. `db:migrate` reports
 * success off this rather than off the call returning: a folder with nothing
 * in it applies nothing, and saying "completed" there reads as a database that
 * is now up to date.
 *
 * It describes the run the driver memoized, not the folder as it stands now.
 * Migrations are single-flighted per handle, so a second call returns this same
 * summary without re-reading the folder — which is the pre-existing no-rerun
 * behaviour, faithfully reported.
 */
export interface MigrationRunSummary {
  /** The folder the migrator read, absolute as the driver resolved it. */
  migrationsFolder: string
  /** drizzle-kit migrations found there (one folder each, holding migration.sql). */
  migrationsFound: number
  /**
   * Loose .sql files in that folder, which the drizzle migrator never runs.
   * Non-zero alongside `migrationsFound: 0` means the folder is not empty but
   * holds nothing to apply, which is a different problem from having generated
   * no migrations yet.
   */
  looseSqlFiles: number
}

/**
 * One read of the migrations folder, answering both questions a run summary
 * asks of it. Kept together because they come from the same directory listing:
 * counting the loose files separately would read it twice to report on one run.
 */
export function inspectMigrationsFolder(migrationsFolder: string): MigrationRunSummary {
  if (!existsSync(migrationsFolder)) {
    return { migrationsFolder, migrationsFound: 0, looseSqlFiles: 0 }
  }

  const entries = readdirSync(migrationsFolder, { withFileTypes: true })

  return {
    migrationsFolder,
    migrationsFound: entries.filter(
      (entry) => entry.isDirectory() && existsSync(resolve(migrationsFolder, entry.name, 'migration.sql')),
    ).length,
    looseSqlFiles: entries.filter((entry) => entry.isFile() && entry.name.endsWith('.sql')).length,
  }
}

/**
 * Reports a run that found nothing to apply, naming the loose .sql files if
 * that is why the folder looked empty — without this, `db:migrate` reports the
 * folder as having no migrations while files that look like migrations sit in
 * it. The names cost a second read, so this only happens when there are some.
 *
 * A folder the migrator did run from is never warned about: it has already
 * produced a database, and the warning would fire on every app boot.
 */
export function noMigrationsToRun(summary: MigrationRunSummary): MigrationRunSummary {
  if (summary.looseSqlFiles === 0) {
    return summary
  }

  const flatSqlFiles = readdirSync(summary.migrationsFolder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)

  console.warn(
    `[guren/orm] Ignoring ${flatSqlFiles.length} loose .sql file(s) in ${summary.migrationsFolder}: ${flatSqlFiles.join(', ')}.\n` +
    '[guren/orm] Migrations must be generated with drizzle-kit (`bun run db:make`), which creates one folder per migration.',
  )

  return summary
}

/**
 * Driver error codes that mean the server was never reached, so the statement
 * drizzle happened to be sending is noise. Deliberately excludes mid-flight
 * failures like ECONNRESET and EPIPE — those can hit halfway through a
 * migration run, where the query text is the useful part.
 *
 * ETIMEDOUT is absent for the same reason, and is instead recognised through
 * `syscall: 'connect'` below: mysql2 reports a connect timeout as
 * `ETIMEDOUT`/`syscall: 'connect'`, while a read that times out mid-query does
 * not carry that syscall.
 */
const PRE_CONNECTION_ERROR_CODES = new Set([
  'CONNECT_TIMEOUT',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
])

interface CauseLike {
  code?: unknown
  message?: unknown
  syscall?: unknown
}

/** True when this error was raised while establishing the connection. */
function failedWhileConnecting(error: CauseLike): error is CauseLike & { code: string } {
  const { code, syscall } = error
  if (typeof code !== 'string' || code === '') {
    return false
  }
  return PRE_CONNECTION_ERROR_CODES.has(code) || syscall === 'connect'
}

/**
 * Walks the cause chain (and AggregateError members) collecting every nested
 * error, outwards-in. `seen` bounds the walk on self-referencing chains.
 */
function collectCauses(error: unknown, seen = new Set<unknown>()): CauseLike[] {
  if (error == null || typeof error !== 'object' || seen.has(error)) {
    return []
  }
  seen.add(error)

  const nested = [
    ...(Array.isArray((error as { errors?: unknown }).errors) ? ((error as { errors: unknown[] }).errors) : []),
    ...('cause' in error ? [(error as { cause: unknown }).cause] : []),
  ]

  return [error as CauseLike, ...nested.flatMap((child) => collectCauses(child, seen))]
}

/** True when the failure means the database server was never reached. */
export function isConnectionFailure(error: unknown): boolean {
  return collectCauses(error).some(failedWhileConnecting)
}

/**
 * Turns a database failure into a message that names the actual problem.
 *
 * Drizzle wraps driver failures in a DrizzleQueryError whose message is the SQL
 * it was running — for a fresh database that is `CREATE SCHEMA IF NOT EXISTS
 * "drizzle"`, the migrator's own bookkeeping statement. Reporting only that
 * message blames a statement the user never wrote for what is usually an
 * unreachable server (postgres-js reports `ECONNREFUSED` on `cause` and leaves
 * that error's message empty) or a SQL error whose text also lives on `cause`.
 *
 * `endpoint` is included only as host:port — never the connection string, which
 * carries credentials.
 */
export function describeDatabaseFailure(error: unknown, endpoint?: string): string {
  const causes = collectCauses(error)

  const connectFailure = causes.find(failedWhileConnecting)
  if (connectFailure) {
    const target = endpoint ? `the database at ${endpoint}` : 'the database'
    return `cannot connect to ${target} (${connectFailure.code}). Is it running and accepting connections?`
  }

  const messages = [
    ...new Set(
      causes
        .map((cause) => cause.message)
        .filter((message): message is string => typeof message === 'string' && message.trim() !== ''),
    ),
  ]

  if (messages.length === 0) {
    return error instanceof Error ? error.message : String(error)
  }

  // A driver that reports only a code (postgres-js leaves the message empty)
  // would otherwise leave the outer query text unexplained. The deepest code is
  // the driver's, not a SQLSTATE an outer frame happened to copy.
  if (messages.length === 1) {
    const deepestCode = causes.reduce<string | undefined>(
      (found, cause) => (typeof cause.code === 'string' && cause.code !== '' ? cause.code : found),
      undefined,
    )
    if (deepestCode) {
      return `${messages[0]} (${deepestCode})`
    }
  }

  return messages.join(' — ')
}

/** Wraps a migration failure in the message `db:migrate` reports. */
export function migrationFailure(error: unknown, endpoint?: string): Error {
  return new Error(`Failed to run database migrations: ${describeDatabaseFailure(error, endpoint)}`)
}

/** Wraps a seeding failure in the message `db:seed` reports. */
export function seedFailure(error: unknown, endpoint?: string): Error {
  return new Error(`Failed to seed the database: ${describeDatabaseFailure(error, endpoint)}`)
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
