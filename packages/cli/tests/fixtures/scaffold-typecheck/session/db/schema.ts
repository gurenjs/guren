// Companion for typechecking templates/scaffold/session: the sessions table the
// blueprint's Postgres schema patch produces (pinned by scaffold-output.test.ts).
// config/session.ts only ever imports the `sessions` export, so this stays valid
// for every dialect the patch supports.
import { index, jsonb, pgTable, text, timestamp } from '@guren/orm/drizzle/pg'

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  data: jsonb('data').$type<Record<string, unknown>>().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (t) => [index('sessions_expires_at_idx').on(t.expiresAt)])
