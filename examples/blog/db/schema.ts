import { pgTable, serial, text, timestamp, uniqueIndex, integer } from '@guren/orm/drizzle'

export const users = pgTable(
  'users',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    rememberToken: text('remember_token'),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    githubId: text('github_id').unique(),
    googleId: text('google_id').unique(),
  },
  (table) => [uniqueIndex('users_email_unique').on(table.email)],
)

export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  excerpt: text('excerpt').notNull(),
  body: text('body'),
  authorId: integer('author_id')
    .notNull()
    .references(() => users.id),
})

export const schema = {
  posts,
  users,
}

export type BlogSchema = typeof schema
