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
