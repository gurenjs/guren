/**
 * Which migration layout a D1 database is on, decided by what its tracker already
 * records (RFC 0035 §6). Wrangler, and cf over the flattened copy, record
 * `<folder>.sql`; cf over drizzle's nested layout records `<folder>/migration.sql`.
 * Pointing a database at the other layout would make its whole history look pending.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export type MigrationLayout = 'nested' | 'flat'

export interface LocalMigrations {
  /** drizzle 1.x folders holding a `migration.sql`, in apply order. */
  folders: string[]
  /** Plain `.sql` files at the top of the migrations directory, which only the flat copy carries. */
  files: string[]
}

export type LayoutDecision =
  | {
    ok: true
    layout: MigrationLayout
    pendingFolders: string[]
    /** Plain files the layout applies, or would leave out (`nested`), both unjudged by the guard. */
    pendingFiles: string[]
    /** Folders and files together, by the name the tracker records, the order cf applies them in. */
    pending: string[]
  }
  | { ok: false; nested: string[]; flat: string[] }
  /** The tracker is on the nested layout, which this backend cannot apply. */
  | { ok: false; unsupported: 'nested'; nested: string[] }

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

/**
 * `tracker` is `null` for a database with no tracker table, or one not created yet.
 * A tracker with no rows takes the flat layout, which the guide's manual apply and
 * Wrangler both use, so the two never record different names for one database.
 * Wrangler applies only the flat copy (`appliesNested` false), where a nested history
 * would all read as pending.
 */
export function decideLayout(local: LocalMigrations, tracker: readonly string[] | null, appliesNested = true): LayoutDecision {
  const rows = tracker ?? []
  const nested = rows.filter((name) => name.endsWith(NESTED_SUFFIX))
  const flat = rows.filter((name) => !name.endsWith(NESTED_SUFFIX))
  if (nested.length > 0 && flat.length > 0) {
    return { ok: false, nested, flat }
  }
  if (nested.length > 0 && !appliesNested) {
    return { ok: false, unsupported: 'nested', nested }
  }

  const layout: MigrationLayout = nested.length > 0 ? 'nested' : 'flat'
  const recorded = (folder: string) => (layout === 'nested' ? `${folder}${NESTED_SUFFIX}` : `${folder}.sql`)
  const applied = new Set(rows)
  const pendingFolders = local.folders.filter((folder) => !applied.has(recorded(folder)))
  const pendingFiles = local.files.filter((file) => !applied.has(file))
  const pending = [...pendingFolders.map((folder) => ({ key: `${folder}.sql`, name: folder })), ...pendingFiles.map((file) => ({ key: file, name: file }))]
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
    .map((entry) => entry.name)
  return { ok: true, layout, pendingFolders, pendingFiles, pending }
}

/** The `cf d1 migrations` arguments for a layout, after the database id. */
export function migrationDirArgs(layout: MigrationLayout, flatDir: string): string[] {
  return layout === 'nested'
    ? ['--dir', 'db/migrations', '--pattern', 'db/migrations/*/migration.sql']
    : ['--dir', flatDir]
}

/** sha256 over each pending migration's name and text, in apply order. */
export function fingerprintMigrations(migrationsDir: string, pending: readonly string[]): string {
  const hash = createHash('sha256')
  for (const name of pending) {
    const path = name.endsWith('.sql') ? join(migrationsDir, name) : join(migrationsDir, name, 'migration.sql')
    hash.update(`${name}\0`).update(readFileSync(path)).update('\0')
  }
  return hash.digest('hex')
}
