// Companion for typechecking templates/scaffold/attachments: the attachments
// table the blueprint's Postgres schema patch produces (pinned by
// scaffold-output.test.ts). config/attachments.ts only ever imports the
// `attachments` export, so this stays valid for every dialect the patch
// supports.
import type { AttachmentVariantRecord } from '@guren/core'
import { index, integer, jsonb, pgTable, text, timestamp } from '@guren/orm/drizzle/pg'

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
