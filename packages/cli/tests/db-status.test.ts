import { describe, expect, it } from 'bun:test'
import { join, resolve } from 'node:path'
import { rm } from 'node:fs/promises'
import {
  assertWorkspaceBuilt,
  createTempWorkspace,
  linkWorkspacePackage,
  runCliBinCaptured,
  writeWorkspaceFiles,
} from './helpers'

const ORM_DIST_ENTRY = resolve(import.meta.dir, '../../orm/dist/index.js')

const SCRATCH_MIGRATION = '20260102000000_create_sessions_table'

/**
 * The shape of chapter 6's `add auth` comparison: a boot applies a generator's
 * migration, then `git clean` removes its folder and nothing else. Goes through
 * the scaffold's own `config/database.ts` and the built `@guren/orm`, since the
 * status the CLI prints is whatever that config's `migrationStatus()` returns.
 */
async function appWithDeletedMigration(dir: string): Promise<void> {
  assertWorkspaceBuilt([ORM_DIST_ENTRY])
  await linkWorkspacePackage('orm', dir)
  await writeWorkspaceFiles(dir, {
    'config/database.ts': `import { createSqliteDatabase } from '@guren/orm'

const database = createSqliteDatabase({
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  filename: new URL('../data/app.db', import.meta.url).pathname,
})

export const { getDatabase, migrateDatabase, closeDatabase, migrationStatus } = database
`,
    'db/migrations/20260101000000_create_users/migration.sql': 'CREATE TABLE users (id integer primary key);',
    [`db/migrations/${SCRATCH_MIGRATION}/migration.sql`]: 'CREATE TABLE sessions (id text primary key);',
  })

  const migrate = await runCliBinCaptured(['db:migrate'], dir)
  expect(migrate.exitCode).toBe(0)
  await rm(join(dir, 'db/migrations', SCRATCH_MIGRATION), { recursive: true })
}

describe('db:status', () => {
  it('lists a migration applied to the database whose folder is gone as orphaned', async () => {
    const workspace = await createTempWorkspace('guren-cli-db-status-orphan-')
    try {
      await appWithDeletedMigration(workspace.dir)

      const { stdout, stderr, exitCode } = await runCliBinCaptured(['db:status'], workspace.dir)
      const output = stdout + stderr

      expect(exitCode).toBe(0)
      expect(output).toMatch(new RegExp(`orphaned\\s+${SCRATCH_MIGRATION}`))
      expect(output).toContain('bun run db:reset')
      expect(output).not.toContain('All migrations applied.')
    } finally {
      await workspace.cleanup()
    }
  })

  it('marks the orphan in --json output', async () => {
    const workspace = await createTempWorkspace('guren-cli-db-status-orphan-json-')
    try {
      await appWithDeletedMigration(workspace.dir)

      const { stdout, exitCode } = await runCliBinCaptured(['db:status', '--json'], workspace.dir)
      const report = JSON.parse(stdout) as { migrations: Array<{ name: string; applied: boolean; orphaned: boolean }> }

      expect(exitCode).toBe(0)
      expect(report.migrations.map(({ name, applied, orphaned }) => ({ name, applied, orphaned }))).toEqual([
        { name: '20260101000000_create_users', applied: true, orphaned: false },
        { name: SCRATCH_MIGRATION, applied: true, orphaned: true },
      ])
    } finally {
      await workspace.cleanup()
    }
  })
})
