import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sql } from 'drizzle-orm'
import { createMySqlDatabase, type MySqlDatabase } from '../src/mysql'

// The unit tests mock `drizzle-orm/mysql2` away, so they cannot see driver-level
// breakage (a wiring shape the adapter rejects, a migrator that never runs).
// CI supplies MYSQL_URL from a mysql service container; locally, start one with
// `bun run db:up:mysql`. MYSQL_URL needs a user allowed to create a database,
// since the compose service only grants the app user rights on its own.
const MYSQL_URL = process.env.MYSQL_URL
const describeMySql = MYSQL_URL ? describe : describe.skip

// Derived rather than taken from MYSQL_URL: the reset below drops every table
// in the database it runs against, and MYSQL_URL is the same string a
// scaffolded app puts in DATABASE_URL.
const TEST_DATABASE = 'guren_orm_test'

function databaseUrl(url: string, database: string): string {
  const target = new URL(url)
  target.pathname = `/${database}`
  return target.toString()
}

async function ensureTestDatabase(url: string): Promise<void> {
  const { createPool } = await import('mysql2/promise')
  const pool = createPool({ uri: databaseUrl(url, 'mysql') })
  try {
    await pool.query(`CREATE DATABASE IF NOT EXISTS \`${TEST_DATABASE}\``)
  } finally {
    await pool.end()
  }
}

function createMigrationsFolder(): string {
  const migrationsFolder = mkdtempSync(join(tmpdir(), 'guren-orm-mysql-integration-'))
  const migrationDir = join(migrationsFolder, '20240101000000_init')
  mkdirSync(migrationDir, { recursive: true })
  writeFileSync(
    join(migrationDir, 'migration.sql'),
    'CREATE TABLE `widgets` (`id` int AUTO_INCREMENT PRIMARY KEY NOT NULL, `name` varchar(255) NOT NULL);',
  )
  return migrationsFolder
}

describeMySql('createMySqlDatabase against a real MySQL server (requires MYSQL_URL)', () => {
  let database: MySqlDatabase

  beforeAll(async () => {
    const url = MYSQL_URL as string
    await ensureTestDatabase(url)
    database = createMySqlDatabase({
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

    const [rows] = (await db.execute(sql`SELECT 1 AS one`)) as unknown as [Array<{ one: number }>]
    expect(rows[0]?.one).toBe(1)

    await db.execute(sql`INSERT INTO \`widgets\` (\`name\`) VALUES ('gear')`)
    const [widgets] = (await db.execute(sql`SELECT \`name\` FROM \`widgets\``)) as unknown as [
      Array<{ name: string }>,
    ]
    expect(widgets.map((widget) => widget.name)).toEqual(['gear'])
  })

  it('reports the applied migration', async () => {
    await database.migrateDatabase()

    const status = await database.migrationStatus()
    expect(status).toHaveLength(1)
    expect(status[0]).toMatchObject({ name: '20240101000000_init', applied: true })
  })

  it('clears table contents on reset and leaves migrations applied', async () => {
    // Explicit setup rather than relying on what the preceding test (or the
    // reset in beforeAll) left behind: the contract under test must be what
    // fails here, not the fixture.
    await database.migrateDatabase()
    const db = await database.getDatabase()
    await db.execute(sql`INSERT INTO \`widgets\` (\`name\`) VALUES ('sprocket')`)

    await database.resetDatabase()

    const status = await database.migrationStatus()
    expect(status[0]).toMatchObject({ applied: true })

    // Queryable without an explicit migrateDatabase(): the reset re-applied it.
    const [widgets] = (await db.execute(sql`SELECT \`name\` FROM \`widgets\``)) as unknown as [
      Array<{ name: string }>,
    ]
    expect(widgets).toEqual([])
  })

  it('drops views on reset, not just base tables', async () => {
    // `widgets` has to exist for the view to select from it, whatever the
    // preceding test left behind.
    await database.migrateDatabase()
    const db = await database.getDatabase()
    await db.execute(sql`CREATE OR REPLACE VIEW \`widget_names\` AS SELECT \`name\` FROM \`widgets\``)

    await database.resetDatabase()

    // Only what the migrations rebuild survives — the view is not among them.
    const [remaining] = (await db.execute(
      sql`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()`,
    )) as unknown as [Array<{ name: string }>]
    expect(remaining.map((row) => row.name)).not.toContain('widget_names')
    expect(remaining.map((row) => row.name)).toContain('widgets')
  })
})
