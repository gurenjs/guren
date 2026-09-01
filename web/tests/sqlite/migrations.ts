/**
 * The committed migrations, applied in order to an in-memory database.
 *
 * Both `tests/sqlite` suites need `search_index_state` to exist as shipped
 * before the generated index SQL lands on top of it, and neither is about how
 * the migrations get there.
 */
import type { Database } from 'bun:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const migrationsDir = join(import.meta.dir, '../../db/migrations')

export function applyMigrations(db: Database): void {
  const directories = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  for (const directory of directories) {
    db.exec(readFileSync(join(migrationsDir, directory, 'migration.sql'), 'utf8'))
  }
}
