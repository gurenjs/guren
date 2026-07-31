import { int, mysqlTable, varchar } from 'drizzle-orm/mysql-core'
import { pgTable, serial, text } from 'drizzle-orm/pg-core'
import { integer, sqliteTable, text as sqliteText } from 'drizzle-orm/sqlite-core'
import {
  defineSeeder,
  type MySqlSeederContext,
  type PostgresSeederContext,
  type SqliteSeederContext,
} from '../src/seeder'

/**
 * A type-only fixture: these seeders are never executed, and `bun run
 * typecheck` is the assertion. `SeederContext` used to be hard-typed as
 * `PostgresJsDatabase`, so a MySQL or SQLite app's own schema was rejected by
 * the context its seeders receive, and dialect-specific builders
 * (`onDuplicateKeyUpdate`) did not exist on it at all. Nothing caught it
 * because the scaffolded `db/` was outside the app tsconfig.
 */

const pgUsers = pgTable('users', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
})

const mysqlUsers = mysqlTable('users', {
  id: int('id').primaryKey().autoincrement(),
  name: varchar('name', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }).notNull().unique(),
})

const sqliteUsers = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: sqliteText('name').notNull(),
  email: sqliteText('email').notNull().unique(),
})

export const postgresSeeder = defineSeeder(async ({ db }: PostgresSeederContext) => {
  await db
    .insert(pgUsers)
    .values({ name: 'Demo', email: 'demo@example.com' })
    .onConflictDoNothing({ target: pgUsers.email })
})

export const mysqlSeeder = defineSeeder(async ({ db }: MySqlSeederContext) => {
  await db
    .insert(mysqlUsers)
    .values({ name: 'Demo', email: 'demo@example.com' })
    .onDuplicateKeyUpdate({ set: { name: 'Demo' } })
})

export const sqliteSeeder = defineSeeder(async ({ db }: SqliteSeederContext) => {
  await db
    .insert(sqliteUsers)
    .values({ name: 'Demo', email: 'demo@example.com' })
    .onConflictDoNothing({ target: sqliteUsers.email })
})

/** Seeders written before the context was generic stay on the PostgreSQL default. */
export const unannotatedSeeder = defineSeeder(async ({ db }) => {
  const rows = await db.select().from(pgUsers).limit(1)
  return rows[0]?.email
})
