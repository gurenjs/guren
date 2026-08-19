import { describe, expect, it } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTempWorkspace } from './helpers'
import { runDatabaseMigrations, runDatabaseSeeders, resetDatabase } from '../src/db-migrate'

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

      const summary = await runDatabaseMigrations()

      expect(calls).toEqual(['migrate', 'close'])
      // A config whose migration function reports nothing (an older @guren/orm,
      // or one the user wrote) must keep the plain success path.
      expect(summary).toBeUndefined()
      delete (globalThis as typeof globalThis & { __calls?: string[] }).__calls
    } finally {
      await workspace.cleanup()
    }
  })

  it('returns what the run found when the config reports it', async () => {
    const workspace = await createTempWorkspace('guren-cli-db-migrate-summary-')
    try {
      await mkdir(join(workspace.dir, 'config'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'config/database.ts'),
        `
export async function migrateDatabase() {
  return { migrationsFolder: '/app/db/migrations', migrationsFound: 0, looseSqlFiles: 2 }
}
`,
        'utf8',
      )

      expect(await runDatabaseMigrations()).toEqual({
        migrationsFolder: '/app/db/migrations',
        migrationsFound: 0,
        looseSqlFiles: 2,
      })
    } finally {
      await workspace.cleanup()
    }
  })

  it('ignores a return value that is not a run summary', async () => {
    const workspace = await createTempWorkspace('guren-cli-db-migrate-other-')
    try {
      await mkdir(join(workspace.dir, 'config'), { recursive: true })
      // `getDatabase` is one of the accepted names, and it resolves to a
      // drizzle instance rather than a summary.
      await writeFile(
        join(workspace.dir, 'config/database.ts'),
        `
export async function getDatabase() {
  return { select() {} }
}
`,
        'utf8',
      )

      expect(await runDatabaseMigrations()).toBeUndefined()
    } finally {
      await workspace.cleanup()
    }
  })

  it('reports the reset run, which re-applies the migrations itself', async () => {
    const workspace = await createTempWorkspace('guren-cli-db-reset-summary-')
    try {
      const calls: string[] = []
      ;(globalThis as typeof globalThis & { __calls?: string[] }).__calls = calls

      await mkdir(join(workspace.dir, 'config'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'config/database.ts'),
        `
export async function resetDatabase() {
  globalThis.__calls.push('reset')
  return { migrationsFolder: '/app/db/migrations', migrationsFound: 0, looseSqlFiles: 0 }
}

export async function migrateDatabase() {
  globalThis.__calls.push('migrate')
  return { migrationsFolder: '/app/db/migrations', migrationsFound: 0, looseSqlFiles: 0 }
}

export async function closeDatabase() {
  globalThis.__calls.push('close')
}
`,
        'utf8',
      )

      const summary = await resetDatabase()

      expect(calls).toEqual(['reset', 'migrate', 'close'])
      // No `seed: true`, so there is no seed run to describe — absent, rather
      // than a summary claiming zero seeders ran.
      expect(summary).toEqual({
        migrations: { migrationsFolder: '/app/db/migrations', migrationsFound: 0, looseSqlFiles: 0 },
        seeders: undefined,
      })
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

      const summary = await runDatabaseSeeders()

      expect(calls).toEqual(['seed', 'close'])
      // A config whose seed function reports nothing (an older @guren/orm, or
      // one the user wrote) must keep the plain success path.
      expect(summary).toBeUndefined()
      delete (globalThis as typeof globalThis & { __calls?: string[] }).__calls
    } finally {
      await workspace.cleanup()
    }
  })

  it('returns what the seed run found when the config reports it', async () => {
    const workspace = await createTempWorkspace('guren-cli-db-seed-summary-')
    try {
      await mkdir(join(workspace.dir, 'config'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'config/database.ts'),
        `
export async function seedDatabase() {
  return { seedersFolder: '/app/db/seeders', seedersRan: 0, filesWithoutSeeder: 1 }
}
`,
        'utf8',
      )

      expect(await runDatabaseSeeders()).toEqual({
        seedersFolder: '/app/db/seeders',
        seedersRan: 0,
        filesWithoutSeeder: 1,
      })
    } finally {
      await workspace.cleanup()
    }
  })

  it('ignores a seed return value that is not a run summary', async () => {
    const workspace = await createTempWorkspace('guren-cli-db-seed-other-')
    try {
      await mkdir(join(workspace.dir, 'config'), { recursive: true })
      // `runSeeders` is one of the accepted names, and a config could forward
      // the handler array a bare loadSeeders()-style helper returns.
      await writeFile(
        join(workspace.dir, 'config/database.ts'),
        `
export async function runSeeders() {
  return []
}
`,
        'utf8',
      )

      expect(await runDatabaseSeeders()).toBeUndefined()
    } finally {
      await workspace.cleanup()
    }
  })

  it('reports both halves of a reset that was asked to seed', async () => {
    const workspace = await createTempWorkspace('guren-cli-db-reset-seed-summary-')
    try {
      await mkdir(join(workspace.dir, 'config'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'config/database.ts'),
        `
export async function resetDatabase() {
  return { migrationsFolder: '/app/db/migrations', migrationsFound: 3, looseSqlFiles: 0 }
}

export async function migrateDatabase() {
  return { migrationsFolder: '/app/db/migrations', migrationsFound: 3, looseSqlFiles: 0 }
}

export async function seedDatabase() {
  return { seedersFolder: '/app/db/seeders', seedersRan: 0, filesWithoutSeeder: 0 }
}
`,
        'utf8',
      )

      // The migrations applied, so the seed half is the only thing left to
      // report — a reset that repopulated nothing.
      expect(await resetDatabase({ seed: true })).toEqual({
        migrations: { migrationsFolder: '/app/db/migrations', migrationsFound: 3, looseSqlFiles: 0 },
        seeders: { seedersFolder: '/app/db/seeders', seedersRan: 0, filesWithoutSeeder: 0 },
      })
    } finally {
      await workspace.cleanup()
    }
  })
})
