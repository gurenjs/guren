import type { AgentPrincipal } from '@guren/core'
import { index, integer, sqliteTable, text } from '@guren/orm/drizzle/sqlite'

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
})

/**
 * Bearer credentials for the operator API, in the shape `ApiTokenStore` reads:
 * `hashed_token` is the lookup key and the plaintext exists only in the seeder's
 * output.
 */
export const apiTokens = sqliteTable(
  'api_tokens',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    hashedToken: text('hashed_token').notNull().unique(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    abilities: text('abilities', { mode: 'json' }).$type<string[]>().notNull(),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [index('api_tokens_user_id_idx').on(table.userId)],
)

export const tickets = sqliteTable(
  'tickets',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    title: text('title').notNull(),
    status: text('status', { enum: ['open', 'closed'] })
      .notNull()
      .default('open'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [index('tickets_status_idx').on(table.status)],
)

/**
 * The RFC 0016 approval queue, as a table (`AgentApprovalStore`).
 * `principal` is JSON because `AgentPrincipal` is the framework's shape, not
 * this app's; `principal_key` and `fingerprint` are the denormalized halves the
 * match query indexes. `consumed_at` is the single-use latch — see
 * `app/Services/DrizzleApprovalStore.ts`.
 */
export const agentApprovals = sqliteTable(
  'agent_approvals',
  {
    id: text('id').primaryKey(),
    tool: text('tool').notNull(),
    input: text('input', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    fingerprint: text('fingerprint').notNull(),
    principal: text('principal', { mode: 'json' }).$type<AgentPrincipal | null>(),
    principalKey: text('principal_key').notNull(),
    requestedAt: text('requested_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    status: text('status', { enum: ['pending', 'approved', 'rejected', 'expired'] })
      .notNull()
      .default('pending'),
    resolvedAt: text('resolved_at'),
    resolvedBy: text('resolved_by'),
    consumedAt: text('consumed_at'),
  },
  (table) => [index('agent_approvals_match_idx').on(table.tool, table.fingerprint, table.principalKey)],
)

export const schema = { users, apiTokens, tickets, agentApprovals }
export type AgentsSchema = typeof schema
