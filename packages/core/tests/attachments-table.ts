/**
 * The `attachments` table the attachment tests share, in both the Drizzle and
 * the raw-DDL form. Column property names must match the contract
 * `ConfigureAttachmentsOptions.table` documents — keeping one copy here is
 * what stops the two suites from drifting into disagreeing about it.
 */
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import type { AttachmentVariantRecord } from '../src/index'

export const attachmentsTable = sqliteTable('attachments', {
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
  variants: text('variants', { mode: 'json' }).$type<Record<string, AttachmentVariantRecord>>(),
  placeholder: text('placeholder'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

export const ATTACHMENTS_DDL = `
  CREATE TABLE attachments (
    id text primary key,
    attachable_type text not null,
    attachable_id text not null,
    collection text not null default 'default',
    disk text not null,
    path text not null,
    name text not null,
    content_type text not null,
    size integer not null,
    width integer,
    height integer,
    variants text,
    placeholder text,
    created_at integer not null,
    updated_at integer not null
  );
`
