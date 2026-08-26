import { index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from '@guren/orm/drizzle/pg'
import type { AttachmentVariantRecord } from '@guren/core'

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

export const attachments = pgTable('attachments', {
  id: text('id').primaryKey(),
  attachableType: text('attachable_type').notNull(),
  attachableId: text('attachable_id').notNull(),
  collection: text('collection').notNull().default('default'),
  disk: text('disk').notNull(),
  path: text('path').notNull(),
  name: text('name').notNull(),
  contentType: text('content_type').notNull(),
  size: integer('size').notNull(),
  width: integer('width'),
  height: integer('height'),
  variants: jsonb('variants').$type<Record<string, AttachmentVariantRecord>>(),
  placeholder: text('placeholder'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('attachments_attachable_idx').on(t.attachableType, t.attachableId, t.collection)])
