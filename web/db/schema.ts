import { check, integer, sql, sqliteTable, text } from '@guren/orm/drizzle/sqlite'

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  // Nullable: admin accounts are created through GitHub OAuth and never
  // carry a password (RFC 0003 §4 — no scrypt inside Workers' CPU budget).
  passwordHash: text('password_hash'),
  rememberToken: text('remember_token'),
  githubId: text('github_id').unique(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
})

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  data: text('data', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
})

export const oauthStates = sqliteTable('oauth_states', {
  stateHash: text('state_hash').primaryKey(),
  provider: text('provider').notNull(),
  redirectTo: text('redirect_to'),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  // Hash of the value tying a state to the browser that started the flow.
  // Nullable: states minted before this column existed carry none.
  binding: text('binding'),
})

export const posts = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  slug: text('slug').notNull().unique(),
  title: text('title').notNull(),
  description: text('description'),
  bodyMarkdown: text('body_markdown').notNull(),
  // Rendered at save time, so the read path does no markdown or highlighting.
  bodyHtml: text('body_html').notNull(),
  publishedAt: integer('published_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
})

/**
 * Which build of the docs search index is loaded in D1; one row. `buildId` is
 * a pure hash of the indexed corpus and names its tables (`doc_sections_<id>`,
 * `doc_search_<id>`); the deploy skips reindexing on a match, or a busy day of
 * deploys exceeds D1's free write budget. Loaded is not live: the index goes in
 * before `wrangler deploy`, so a failed deploy leaves this row ahead of the Worker.
 */
export const searchIndexState = sqliteTable(
  'search_index_state',
  {
    id: integer('id').primaryKey(),
    buildId: text('build_id').notNull(),
    // The build this one replaced, kept so its tables survive a rollback:
    // `wrangler rollback` activates an earlier Worker, which names earlier
    // tables, and Cloudflare does not roll a D1 database back with it.
    previousBuildId: text('previous_build_id'),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => [check('search_index_state_single_row', sql`${table.id} = 1`)],
)
