import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sql } from 'drizzle-orm'
import { createPostgresDatabase, type PostgresDatabase } from '../src/postgres'

// The unit tests in postgres.test.ts mock `postgres` and the migrator away, so
// they can assert that a migration run *happens* but never that the database
// ends up usable. CI supplies POSTGRES_URL from its postgres service; locally,
// start one with `bun run db:up`. POSTGRES_URL needs a user allowed to create a
// database, since the reset below drops every schema in the one it runs against.
const POSTGRES_URL = process.env.POSTGRES_URL
const describePostgres = POSTGRES_URL ? describe : describe.skip

// Derived rather than taken from POSTGRES_URL, which is the same string a
// scaffolded app puts in DATABASE_URL.
const TEST_DATABASE = 'guren_orm_test'

function databaseUrl(url: string, database: string): string {
  const target = new URL(url)
  target.pathname = `/${database}`
  return target.toString()
}

async function ensureTestDatabase(url: string): Promise<void> {
  const { default: postgres } = await import('postgres')
  const admin = postgres(databaseUrl(url, 'postgres'), { max: 1 })
  try {
    const existing = await admin.unsafe(`SELECT 1 FROM pg_database WHERE datname = '${TEST_DATABASE}'`)
    // Postgres has no CREATE DATABASE IF NOT EXISTS.
    if (existing.length === 0) {
      await admin.unsafe(`CREATE DATABASE "${TEST_DATABASE}"`)
    }
  } finally {
    await admin.end({ timeout: 0 })
  }
}

function createMigrationsFolder(): string {
  const migrationsFolder = mkdtempSync(join(tmpdir(), 'guren-orm-postgres-integration-'))
  const migrationDir = join(migrationsFolder, '20240101000000_init')
  mkdirSync(migrationDir, { recursive: true })
  writeFileSync(
    join(migrationDir, 'migration.sql'),
    'CREATE TABLE "widgets" ("id" serial PRIMARY KEY NOT NULL, "name" varchar(255) NOT NULL);',
  )
  return migrationsFolder
}

describePostgres('createPostgresDatabase against a real PostgreSQL server (requires POSTGRES_URL)', () => {
  let database: PostgresDatabase

  beforeAll(async () => {
    const url = POSTGRES_URL as string
    await ensureTestDatabase(url)
    database = createPostgresDatabase({
      migrationsFolder: createMigrationsFolder(),
      connectionString: () => databaseUrl(url, TEST_DATABASE),
    })
    await database.resetDatabase()
  })

  afterAll(async () => {
    // beforeAll may have thrown before `database` was assigned — don't mask
    // that failure with a "Cannot read properties of undefined" here.
    await database?.closeDatabase()
  })

  it('runs migrations and queries through the real driver', async () => {
    const db = await database.getDatabase()

    await db.execute(sql`INSERT INTO "widgets" ("name") VALUES ('gear')`)
    const widgets = (await db.execute(sql`SELECT "name" FROM "widgets"`)) as unknown as Array<{ name: string }>
    expect(widgets.map((widget) => widget.name)).toEqual(['gear'])
  })

  it('clears table contents on reset and leaves migrations applied', async () => {
    // Explicit setup rather than relying on what the preceding test (or the
    // reset in beforeAll) left behind: the contract under test must be what
    // fails here, not the fixture.
    await database.migrateDatabase()
    const db = await database.getDatabase()
    await db.execute(sql`INSERT INTO "widgets" ("name") VALUES ('sprocket')`)

    await database.resetDatabase()

    const status = await database.migrationStatus()
    expect(status[0]).toMatchObject({ applied: true })

    // Queryable without an explicit migrateDatabase(): the reset re-applied it.
    // This is the issue-400 repro — the handle predates the reset, so nothing
    // re-migrates on the way to the query.
    const widgets = (await db.execute(sql`SELECT "name" FROM "widgets"`)) as unknown as Array<{ name: string }>
    expect(widgets).toEqual([])
  })

  it('drops views on reset, not just base tables', async () => {
    // `widgets` has to exist for the view to select from it, whatever the
    // preceding test left behind.
    await database.migrateDatabase()
    const db = await database.getDatabase()
    await db.execute(sql`CREATE OR REPLACE VIEW "widget_names" AS SELECT "name" FROM "widgets"`)

    await database.resetDatabase()

    // Only what the migrations rebuild survives — the view is not among them.
    const remaining = (await db.execute(
      sql`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public'`,
    )) as unknown as Array<{ name: string }>
    expect(remaining.map((row) => row.name)).not.toContain('widget_names')
    expect(remaining.map((row) => row.name)).toContain('widgets')
  })
})
