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
