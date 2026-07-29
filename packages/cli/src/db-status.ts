import { consola } from 'consola'
import { resolveDatabaseModule } from './db-migrate'

export interface MigrationStatusRow {
  name: string
  applied: boolean
  appliedAt: string | null
}

type StatusFn = () => Promise<Array<{ name: string; applied: boolean; appliedAt: Date | null }>>
type CloseFn = () => Promise<void>

function pickFunction<T>(module: Record<string, unknown>, name: string): T | undefined {
  const direct = module[name]
  if (typeof direct === 'function') {
    return direct as T
  }

  const defaultExport = module.default
  if (defaultExport && typeof defaultExport === 'object') {
    const nested = (defaultExport as Record<string, unknown>)[name]
    if (typeof nested === 'function') {
      return nested as T
    }
  }

  return undefined
}

export async function getMigrationStatus(): Promise<MigrationStatusRow[]> {
  const module = await resolveDatabaseModule()
  const status = pickFunction<StatusFn>(module, 'migrationStatus')
  const close = pickFunction<CloseFn>(module, 'closeDatabase')

  if (!status) {
    throw new Error(
      'config/database.ts must export migrationStatus(). It is returned by ' +
        'createSqliteDatabase()/createPostgresDatabase()/createMySqlDatabase()/createAwsDataApiDatabase() — ' +
        'add it to the export list in config/database.ts.',
    )
  }

  try {
    const rows = await status()
    return rows.map((row) => ({
      name: row.name,
      applied: row.applied,
      appliedAt: row.appliedAt ? row.appliedAt.toISOString() : null,
    }))
  } finally {
    if (close) {
      await close()
    }
  }
}

export async function showMigrationStatus(options: { json?: boolean } = {}): Promise<void> {
  const rows = await getMigrationStatus()

  if (options.json) {
    console.log(JSON.stringify({ command: 'db:status', migrations: rows }, null, 2))
    return
  }

  if (rows.length === 0) {
    consola.info('No migrations found. Generate one with `bun run db:make`.')
    return
  }

  const pending = rows.filter((row) => !row.applied).length
  for (const row of rows) {
    const marker = row.applied ? '✓ applied' : '· pending'
    const timestamp = row.appliedAt ? ` (${row.appliedAt})` : ''
    consola.log(`  ${marker}  ${row.name}${timestamp}`)
  }

  if (pending > 0) {
    consola.info(`${pending} pending migration(s). Run \`bun run db:migrate\` to apply them.`)
  } else {
    consola.success('All migrations applied.')
  }
}
