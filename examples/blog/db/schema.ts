import { pgTable, serial, text, uniqueIndex } from '@guren/orm/drizzle'

export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  excerpt: text('excerpt').notNull(),
  body: text('body'),
})

export const users = pgTable(
  'users',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    rememberToken: text('remember_token'),
  },
  (table) => [uniqueIndex('users_email_unique').on(table.email)],
)

export const schema = {
  posts,
  users,
}

export type BlogSchema = typeof schema
