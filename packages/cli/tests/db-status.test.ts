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

describe('db:status', () => {
  // Through a scaffold-shaped config/database.ts and the built @guren/orm: the
  // CLI prints whatever that config's migrationStatus() returns.
  it('lists a migration applied to the database whose folder is gone as orphaned', async () => {
    assertWorkspaceBuilt([ORM_DIST_ENTRY])
    const workspace = await createTempWorkspace('guren-cli-db-status-orphan-')
    try {
      await linkWorkspacePackage('orm', workspace.dir)
      await writeWorkspaceFiles(workspace.dir, {
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

      expect((await runCliBinCaptured(['db:migrate'], workspace.dir)).exitCode).toBe(0)
      await rm(join(workspace.dir, 'db/migrations', SCRATCH_MIGRATION), { recursive: true })

      const text = await runCliBinCaptured(['db:status'], workspace.dir)
      const output = text.stdout + text.stderr
      expect(text.exitCode).toBe(0)
      expect(output).toMatch(new RegExp(`orphaned\\s+${SCRATCH_MIGRATION}`))
      expect(output).toContain('bun run db:reset')
      expect(output).not.toContain('All migrations applied.')

      const json = await runCliBinCaptured(['db:status', '--json'], workspace.dir)
      const report = JSON.parse(json.stdout) as { migrations: Array<{ name: string; applied: boolean; orphaned: boolean }> }
      expect(json.exitCode).toBe(0)
      expect(report.migrations.map(({ name, applied, orphaned }) => ({ name, applied, orphaned }))).toEqual([
        { name: '20260101000000_create_users', applied: true, orphaned: false },
        { name: SCRATCH_MIGRATION, applied: true, orphaned: true },
      ])
    } finally {
      await workspace.cleanup()
    }
  })
})
