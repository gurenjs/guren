import { randomUUID } from 'node:crypto'
import { Database } from 'bun:sqlite'
import { drizzle as sqliteDrizzle } from 'drizzle-orm/bun-sqlite'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { pgTable, integer as pgInteger, text as pgText, timestamp } from 'drizzle-orm/pg-core'
import { mysqlTable, int, varchar, datetime } from 'drizzle-orm/mysql-core'
import type { DrizzleDatabase } from '../src/adapters/drizzle-types'

export interface WriteFixture {
  db: DrizzleDatabase
  table: unknown
  clear(): Promise<void>
  close(): Promise<void>
}

export function sqliteWriteFixture(): WriteFixture {
  const client = new Database(':memory:')
  const table = sqliteTable('entries', {
    id: integer('id').primaryKey(), tenant: integer('tenant').notNull(),
    name: text('name').notNull(), deletedAt: integer('deleted_at', { mode: 'timestamp' }),
  })
  client.exec('CREATE TABLE entries (id integer primary key, tenant integer not null, name text not null, deleted_at integer)')
  return {
    db: sqliteDrizzle({ client }) as unknown as DrizzleDatabase, table,
    async clear() { client.exec('DELETE FROM entries') },
    async close() { client.close() },
  }
}

/** Each live fixture owns a new database; never reset the database named in a supplied URL. */
export async function postgresWriteFixture(url: string): Promise<WriteFixture> {
  const { default: postgres } = await import('postgres')
  const { drizzle } = await import('drizzle-orm/postgres-js')
  const name = `guren_contract_${randomUUID().replaceAll('-', '')}`
  const admin = postgres(url, { max: 1 })
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`)
  } catch (error) {
    await admin.end()
    throw error
  }
  const target = new URL(url)
  target.pathname = `/${name}`
  const client = postgres(target.toString(), { max: 2 })
  try {
    await client.unsafe('CREATE TABLE entries (id integer primary key, tenant integer not null, name text not null, deleted_at timestamp)')
    const table = pgTable('entries', {
      id: pgInteger('id').primaryKey(), tenant: pgInteger('tenant').notNull(),
      name: pgText('name').notNull(), deletedAt: timestamp('deleted_at', { mode: 'date' }),
    })
    return {
      db: drizzle({ client }) as unknown as DrizzleDatabase, table,
      async clear() { await client.unsafe('DELETE FROM entries') },
      async close() {
        await client.end()
        try { await admin.unsafe(`DROP DATABASE "${name}"`) } finally { await admin.end() }
      },
    }
  } catch (error) {
    await client.end()
    try { await admin.unsafe(`DROP DATABASE "${name}"`) } finally { await admin.end() }
    throw error
  }
}

export async function mysqlWriteFixture(url: string): Promise<WriteFixture> {
  const { createPool } = await import('mysql2')
  const { drizzle } = await import('drizzle-orm/mysql2')
  const name = `guren_contract_${randomUUID().replaceAll('-', '')}`
  const admin = createPool({ uri: url, connectionLimit: 1 }).promise()
  try {
    await admin.query(`CREATE DATABASE \`${name}\``)
  } catch (error) {
    await admin.end()
    throw error
  }
  const target = new URL(url)
  target.pathname = `/${name}`
  const pool = createPool({ uri: target.toString(), connectionLimit: 2 })
  const client = pool.promise()
  try {
    await client.query('CREATE TABLE entries (id integer primary key, tenant integer not null, name varchar(255) not null, deleted_at datetime)')
    const table = mysqlTable('entries', {
      id: int('id').primaryKey(), tenant: int('tenant').notNull(),
      name: varchar('name', { length: 255 }).notNull(), deletedAt: datetime('deleted_at', { mode: 'date' }),
    })
    return {
      db: drizzle({ client: pool }) as unknown as DrizzleDatabase, table,
      async clear() { await client.query('DELETE FROM entries') },
      async close() {
        await client.end()
        try { await admin.query(`DROP DATABASE \`${name}\``) } finally { await admin.end() }
      },
    }
  } catch (error) {
    await client.end()
    try { await admin.query(`DROP DATABASE \`${name}\``) } finally { await admin.end() }
    throw error
  }
}
