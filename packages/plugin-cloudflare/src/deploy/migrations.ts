/**
 * Which migration layout a D1 database is on, decided by what its tracker already
 * records (RFC 0035 §6). Wrangler, and cf over the flattened copy, record
 * `<folder>.sql`; cf over drizzle's nested layout records `<folder>/migration.sql`.
 * Pointing a database at the other layout would make its whole history look pending.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export type MigrationLayout = 'nested' | 'flat'

export interface LocalMigrations {
  /** drizzle 1.x folders holding a `migration.sql`, in apply order. */
  folders: string[]
  /** Plain `.sql` files at the top of the migrations directory, which only the flat copy carries. */
  files: string[]
}

export type LayoutDecision =
  | { ok: true; layout: MigrationLayout; pendingFolders: string[]; pendingFiles: string[] }
  | { ok: false; nested: string[]; flat: string[] }

const NESTED_SUFFIX = '/migration.sql'

/** The same entries `flattenD1Migrations()` copies, sorted the way cf and Wrangler apply them. */
export function readLocalMigrations(migrationsDir: string): LocalMigrations {
  if (!existsSync(migrationsDir)) return { folders: [], files: [] }
  const folders: string[] = []
  const files: string[] = []
  for (const entry of readdirSync(migrationsDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.sql')) files.push(entry.name)
    if (entry.isDirectory() && entry.name !== 'meta' && existsSync(join(migrationsDir, entry.name, 'migration.sql'))) {
      folders.push(entry.name)
    }
  }
  return { folders: folders.sort(), files: files.sort() }
}

/** `tracker` is `null` for a database with no tracker table, or one not created yet. */
export function decideLayout(local: LocalMigrations, tracker: readonly string[] | null): LayoutDecision {
  const rows = tracker ?? []
  const nested = rows.filter((name) => name.endsWith(NESTED_SUFFIX))
  const flat = rows.filter((name) => !name.endsWith(NESTED_SUFFIX))
  if (nested.length > 0 && flat.length > 0) {
    return { ok: false, nested, flat }
  }

  if (flat.length > 0) {
    const applied = new Set(flat)
    return {
      ok: true,
      layout: 'flat',
      pendingFolders: local.folders.filter((folder) => !applied.has(`${folder}.sql`)),
      pendingFiles: local.files.filter((file) => !applied.has(file)),
    }
  }

  // A fresh database, or one cf has applied the nested layout to. Plain files are not part of that layout.
  const applied = new Set(nested)
  return {
    ok: true,
    layout: 'nested',
    pendingFolders: local.folders.filter((folder) => !applied.has(`${folder}${NESTED_SUFFIX}`)),
    pendingFiles: [],
  }
}

/** The `cf d1 migrations` arguments for a layout, after the database id. */
export function migrationDirArgs(layout: MigrationLayout, flatDir: string): string[] {
  return layout === 'nested'
    ? ['--dir', 'db/migrations', '--pattern', 'db/migrations/*/migration.sql']
    : ['--dir', flatDir]
}
