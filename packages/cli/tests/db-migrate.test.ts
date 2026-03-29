import { describe, expect, it } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTempWorkspace } from './helpers'
import { runDatabaseMigrations, runDatabaseSeeders } from '../src/db-migrate'

describe('db-migrate helpers', () => {
  it('runs migrations and closes the database', async () => {
    const workspace = await createTempWorkspace('guren-cli-db-migrate-')
    try {
      const calls: string[] = []
      ;(globalThis as typeof globalThis & { __calls?: string[] }).__calls = calls

      await mkdir(join(workspace.dir, 'config'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'config/database.ts'),
        `
export async function runMigrations() {
  globalThis.__calls.push('migrate')
}

export async function closeDatabase() {
  globalThis.__calls.push('close')
}
`,
        'utf8',
      )

      await runDatabaseMigrations()

      expect(calls).toEqual(['migrate', 'close'])
      delete (globalThis as typeof globalThis & { __calls?: string[] }).__calls
    } finally {
      await workspace.cleanup()
    }
  })

  it('runs seeders and closes the database', async () => {
    const workspace = await createTempWorkspace('guren-cli-db-seed-')
    try {
      const calls: string[] = []
      ;(globalThis as typeof globalThis & { __calls?: string[] }).__calls = calls

      await mkdir(join(workspace.dir, 'config'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'config/database.ts'),
        `
export async function seedDatabase() {
  globalThis.__calls.push('seed')
}

export async function closeDatabase() {
  globalThis.__calls.push('close')
}
`,
        'utf8',
      )

      await runDatabaseSeeders()

      expect(calls).toEqual(['seed', 'close'])
      delete (globalThis as typeof globalThis & { __calls?: string[] }).__calls
    } finally {
      await workspace.cleanup()
    }
  })
})
