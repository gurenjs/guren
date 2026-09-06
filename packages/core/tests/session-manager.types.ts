/**
 * Type-level tests for the `database` driver's `SessionDrivers` augmentation
 * (RFC 0020 §1). Compiled by the root `tsc --noEmit`; never executed.
 */
import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core'
import type { SessionConfig } from '@guren/server'
import { createSessionManager } from '../src/session-manager'

const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  data: text('data', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
})

export const config: SessionConfig = {
  default: 'database',
  stores: {
    database: { driver: 'database', table: sessions, dataMode: 'text' },
    memory: { driver: 'memory' },
  },
}

export const manager = createSessionManager(config)

// @ts-expect-error `table` is required by the database driver.
export const missingTable: SessionConfig = { stores: { database: { driver: 'database' } } }

// @ts-expect-error An undeclared driver name is not assignable.
export const unknownDriver: SessionConfig = { stores: { x: { driver: 'dynamodb', table: 'sessions' } } }
