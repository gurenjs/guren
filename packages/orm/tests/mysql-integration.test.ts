import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sql } from 'drizzle-orm'
import { createMySqlDatabase, type MySqlDatabase } from '../src/mysql'

// The unit tests mock `drizzle-orm/mysql2` away, so they cannot see driver-level
// breakage (a wiring shape the adapter rejects, a migrator that never runs).
// CI supplies MYSQL_URL from a mysql service container; locally, start one with
// `bun run db:up:mysql`.
//
// MYSQL_URL must name a database dedicated to this test — the reset below drops
// every table in it — and a user allowed to create that database, since the
// compose service only grants the app user rights on its own.
const MYSQL_URL = process.env.MYSQL_URL
const describeMySql = MYSQL_URL ? describe : describe.skip

async function ensureDatabase(url: string): Promise<void> {
  const { createPool } = await import('mysql2/promise')
  const target = new URL(url)
  const name = decodeURIComponent(target.pathname.slice(1))
  target.pathname = '/mysql'

  const pool = createPool({ uri: target.toString() })
  try {
    await pool.query(`CREATE DATABASE IF NOT EXISTS \`${name.replaceAll('`', '``')}\``)
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
  let database: MySqlDatabase | undefined

  beforeAll(async () => {
    await ensureDatabase(MYSQL_URL as string)
    database = createMySqlDatabase({
      migrationsFolder: createMigrationsFolder(),
      connectionString: () => MYSQL_URL,
    })
    await database.resetDatabase()
  })

  afterAll(async () => {
    // beforeAll may have thrown before `database` was assigned — don't mask
    // that failure with a "Cannot read properties of undefined" here.
    await database?.closeDatabase()
  })

  function getDatabaseHandle(): MySqlDatabase {
    if (!database) {
      throw new Error('beforeAll did not set up the database handle')
    }
    return database
  }

  it('runs migrations and queries through the real driver', async () => {
    const database = getDatabaseHandle()
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
    const database = getDatabaseHandle()
    await database.migrateDatabase()

    const status = await database.migrationStatus()
    expect(status).toHaveLength(1)
    expect(status[0]).toMatchObject({ name: '20240101000000_init', applied: true })
  })

  it('drops every table on reset', async () => {
    const database = getDatabaseHandle()
    await database.migrateDatabase()
    await database.resetDatabase()

    const status = await database.migrationStatus()
    expect(status[0]).toMatchObject({ applied: false })
  })
})
