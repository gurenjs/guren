// Imported from drizzle-orm/mysql-core rather than @guren/orm/drizzle, which
// re-exports `text` and `timestamp` from pg-core only — taking them from there
// would build a MySQL table out of PostgreSQL column builders. Drizzle happens
// to emit the same DDL either way today; this does not rely on that.
import { mysqlTable, int, varchar, text, timestamp } from 'drizzle-orm/mysql-core'

export const users = mysqlTable('users', {
  id: int('id').primaryKey().autoincrement(),
  name: varchar('name', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  rememberToken: varchar('remember_token', { length: 255 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

export const posts = mysqlTable('posts', {
  id: int('id').primaryKey().autoincrement(),
  title: varchar('title', { length: 255 }).notNull(),
  excerpt: varchar('excerpt', { length: 500 }).notNull(),
  body: text('body').notNull(),
  authorId: int('author_id')
    .notNull()
    .references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})
