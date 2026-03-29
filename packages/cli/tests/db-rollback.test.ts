import { describe, expect, it } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTempWorkspace } from './helpers'
import { runDatabaseRollback, showMigrationStatus } from '../src/db-rollback'

describe('db-rollback helpers', () => {
  it('handles empty migration sets and closes the database', async () => {
    const workspace = await createTempWorkspace('guren-cli-db-rollback-')
    try {
      const calls: string[] = []
      ;(globalThis as typeof globalThis & { __calls?: string[] }).__calls = calls

      await mkdir(join(workspace.dir, 'config'), { recursive: true })
      await mkdir(join(workspace.dir, 'db/migrations'), { recursive: true })

      await writeFile(
        join(workspace.dir, 'config/database.ts'),
        `
export async function getDatabase() {
  return {
    execute: async (sql) => {
      globalThis.__calls.push(sql)
    },
    query: async () => [],
  }
}

export async function closeDatabase() {
  globalThis.__calls.push('close')
}
`,
        'utf8',
      )

      await runDatabaseRollback({ migrationsDir: join(workspace.dir, 'db/migrations') })
      await showMigrationStatus()

      expect(calls).toContain('close')
      delete (globalThis as typeof globalThis & { __calls?: string[] }).__calls
    } finally {
      await workspace.cleanup()
    }
  })
})
