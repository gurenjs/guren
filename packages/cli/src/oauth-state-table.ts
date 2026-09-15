import {
  appendSchemaTable,
  ensureMysqlImports,
  ensurePgImports,
  ensureSqliteImports,
  type SchemaDialect,
} from './patch-helpers'

/**
 * The `oauth_states` table per dialect, with the column property names
 * DatabaseOAuthStateStore reads. `binding` is what a session-bound state is
 * verified against; without it every callback is rejected at runtime, not at
 * compile time. Both hashes are hex digests, 128 characters under sha512.
 */
const OAUTH_STATES_TABLE_BLOCKS: Record<SchemaDialect, string> = {
  pg: `export const oauthStates = pgTable('oauth_states', {
  stateHash: text('state_hash').primaryKey(),
  provider: text('provider').notNull(),
  redirectTo: text('redirect_to'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  binding: text('binding'),
}, (t) => [index('oauth_states_expires_at_idx').on(t.expiresAt)])
`,
  sqlite: `export const oauthStates = sqliteTable('oauth_states', {
  stateHash: text('state_hash').primaryKey(),
  provider: text('provider').notNull(),
  redirectTo: text('redirect_to'),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  binding: text('binding'),
}, (t) => [index('oauth_states_expires_at_idx').on(t.expiresAt)])
`,
  mysql: `export const oauthStates = mysqlTable('oauth_states', {
  stateHash: varchar('state_hash', { length: 128 }).primaryKey(),
  provider: varchar('provider', { length: 64 }).notNull(),
  redirectTo: text('redirect_to'),
  expiresAt: timestamp('expires_at').notNull(),
  binding: varchar('binding', { length: 128 }),
}, (t) => [index('oauth_states_expires_at_idx').on(t.expiresAt)])
`,
}

const SCHEMA_IMPORTS: Record<SchemaDialect, (content: string) => string> = {
  pg: (content) => ensurePgImports(content, ['pgTable', 'text', 'timestamp', 'index']),
  sqlite: (content) => ensureSqliteImports(content, ['sqliteTable', 'text', 'integer', 'index']),
  mysql: (content) => ensureMysqlImports(content, ['mysqlTable', 'varchar', 'text', 'timestamp', 'index']),
}

/** Whether this run added `oauthStates` to db/schema.ts, which is what a migration would cover. */
export async function appendOAuthStateTable(): Promise<boolean> {
  const result = await appendSchemaTable({
    name: 'oauthStates',
    blocks: OAUTH_STATES_TABLE_BLOCKS,
    imports: SCHEMA_IMPORTS,
    manualGuidance: 'OAuth state needs an oauth_states table.',
  })
  return result === 'appended'
}
