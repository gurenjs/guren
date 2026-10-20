import { existsSync, readdirSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import {
  judgeMigrations,
  readMigrationSources,
  type JudgeOptions,
  type MigrationDialect,
  type MigrationGuardReport,
  type MigrationSource,
} from '@guren/orm/internal/migration-guard'
import { CliError } from './cli-error'
import { describePath } from './commands/display-paths'
import { resolveDatabaseModule } from './db-migrate'
import { pickFunction } from './db-status'
import { resolveMigrationsOutput } from './make-migration'

type StatusRow = { name: string; applied: boolean; orphaned?: boolean; path?: unknown }

/** What `db:migrate` judged before applying anything (RFC 0034 §3). */
export interface PendingMigrationJudgement extends MigrationGuardReport {
  /** The migrations judged, in apply order. */
  pending: string[]
  /** `status` when `migrationStatus()` named them; `all` when the config exports none, so every local migration was judged. */
  pendingFrom: 'status' | 'all'
}

/**
 * How the app's factory runs migrations, read from its `describe()` (exported, or
 * on the `defineDatabaseConfig()` default export). Only bun:sqlite's runner turns
 * foreign keys off around a rebuild; anything unread keeps them on.
 */
function describeRunner(module: Record<string, unknown>): { dialect?: MigrationDialect } & Pick<JudgeOptions, 'foreignKeysEnforced'> {
  try {
    const definition = module.default as { key?: unknown; resolve?: (env: undefined) => { database?: unknown } } | undefined
    const database = definition?.key === 'database' && typeof definition.resolve === 'function' ? definition.resolve(undefined)?.database : module
    const describe = (database as { describe?: () => { dialect?: unknown } } | undefined)?.describe
    const dialect = typeof describe === 'function' ? describe.call(database)?.dialect : undefined
    if (dialect === 'sqlite') return { dialect: 'sqlite', foreignKeysEnforced: false }
    if (dialect === 'd1') return { dialect: 'sqlite' }
    if (dialect === 'postgres' || dialect === 'mysql') return { dialect }
  } catch {
    // An unreadable description judges as an unknown runner.
  }
  return {}
}

function localMigrationNames(folder: string): string[] {
  if (!existsSync(folder)) return []
  return readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(resolve(folder, entry.name, 'migration.sql')))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
}

/**
 * Reads the pending migrations through the app's `migrationStatus()` and judges
 * them. Fails closed: a pending migration whose file is not where the status
 * row (or, from an older `@guren/orm` with no `path`, the drizzle config's
 * `out`) says is a refusal, and a config with no `migrationStatus()` has every
 * local migration judged.
 */
export async function judgePendingMigrations(cwd = process.cwd()): Promise<PendingMigrationJudgement> {
  const module = await resolveDatabaseModule()
  const status = pickFunction<() => Promise<StatusRow[]>>(module, 'migrationStatus')
  const close = pickFunction<() => Promise<void>>(module, 'closeDatabase')
  const { dialect, foreignKeysEnforced } = describeRunner(module)

  if (!status) {
    const folder = await resolveMigrationsOutput(cwd)
    const names = localMigrationNames(folder)
    // Over every migration, applied ones included, an earlier CREATE must not exempt a new DROP.
    const sources = readMigrationSources(folder, names, describePath(folder), { dialect })
    return { ...judgeMigrations(sources, { exemptCreatedInRun: false, foreignKeysEnforced }), pending: names, pendingFrom: 'all' }
  }

  let rows: StatusRow[]
  try {
    rows = await status()
  } finally {
    if (close) await close()
  }

  const pending = rows.filter((row) => !row.applied && !row.orphaned)
  let fallbackFolder: string | undefined
  const sources: MigrationSource[] = []
  for (const row of pending) {
    let folder: string
    if (typeof row.path === 'string' && basename(dirname(row.path)) === row.name) {
      folder = dirname(dirname(row.path))
    } else {
      fallbackFolder ??= await resolveMigrationsOutput(cwd)
      folder = fallbackFolder
    }
    const file = resolve(folder, row.name, 'migration.sql')
    if (!existsSync(file)) {
      throw new CliError(
        `Pending migration ${row.name} has no ${describePath(file)}, so it cannot be checked for destructive statements. ` +
          "The drizzle config's `out` and the factory's `migrationsFolder` in config/database.ts must name the same folder.",
      )
    }
    sources.push(...readMigrationSources(folder, [row.name], describePath(folder), { dialect }))
  }

  return { ...judgeMigrations(sources, { foreignKeysEnforced }), pending: pending.map((row) => row.name), pendingFrom: 'status' }
}
