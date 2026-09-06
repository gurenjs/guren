import { consola } from 'consola'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { registerConsoleCommand } from './console-registrar'
import { appBindsService, fileExists, readIfExists } from './discovery'
import { generateSchemaMigration } from './make-migration'
import {
  appendSchemaTable,
  ensureMysqlImports,
  ensurePgImports,
  ensureSqliteImports,
  type SchemaDialect,
} from './patch-helpers'
import { wireProviders } from './provider-registrar'
import { scaffoldTemplateFile } from './scaffold-templates'
import { writeScaffoldFiles, type WriterOptions } from './utils'

const ENV_FILES = ['.env.example', '.env'] as const

/**
 * The `sessions` table per dialect, matching what DatabaseSessionStore reads:
 * `id`, `data`, `expiresAt`. Postgres uses `withTimezone` per the `guren check`
 * schema rule. The index is on `expires_at`, which both `touch()` and
 * `deleteExpired()` filter on; the store writes every timestamp itself, so no
 * dialect carries a default.
 */
const SESSIONS_TABLE_BLOCKS: Record<SchemaDialect, string> = {
  pg: `export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  data: jsonb('data').$type<Record<string, unknown>>().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (t) => [index('sessions_expires_at_idx').on(t.expiresAt)])
`,
  sqlite: `export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  data: text('data', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
}, (t) => [index('sessions_expires_at_idx').on(t.expiresAt)])
`,
  mysql: `export const sessions = mysqlTable('sessions', {
  id: varchar('id', { length: 64 }).primaryKey(),
  data: json('data').$type<Record<string, unknown>>().notNull(),
  expiresAt: timestamp('expires_at').notNull(),
}, (t) => [index('sessions_expires_at_idx').on(t.expiresAt)])
`,
}

const SCHEMA_IMPORTS: Record<SchemaDialect, (content: string) => string> = {
  pg: (content) => ensurePgImports(content, ['pgTable', 'text', 'jsonb', 'timestamp', 'index']),
  sqlite: (content) => ensureSqliteImports(content, ['sqliteTable', 'text', 'integer', 'index']),
  mysql: (content) => ensureMysqlImports(content, ['mysqlTable', 'varchar', 'json', 'timestamp', 'index']),
}

const SCAFFOLD_PATHS = ['config/session.ts', 'app/Providers/SessionProvider.ts'] as const

export interface AddSessionOptions extends WriterOptions {
  /** Leave the migration to the caller, which is generating one over the same schema. */
  migration?: boolean
  /** Set false to write the files without touching `src/app.ts` or `src/console.ts`. */
  wire?: boolean
}

export interface AddSessionResult {
  files: string[]
  /** Whether `db/schema.ts` gained the table in this run, which is what a migration would cover. */
  schemaChanged: boolean
}

/**
 * Whether the app already has sessions of its own: the conventional config
 * file, or a `session` binding from a provider under any name. Both directions
 * matter — a second manager would shadow the app's, and a config file with no
 * provider leaves sessions on the in-memory default.
 */
export async function appConfiguresSessions(): Promise<boolean> {
  return (await fileExists(process.cwd(), 'config/session.ts'))
    || (await appBindsService('session', process.cwd())).length > 0
}

/**
 * `guren add session`: the `sessions` schema table and its migration,
 * `config/session.ts` + `SessionProvider`, the `SESSION_DRIVER` env entry, and
 * the `sessions:prune` command. Without it an app's sessions live in process
 * memory, which is correct on one long-lived server and drops every login on
 * Workers, Lambda and Vercel (RFC 0020).
 */
export async function addSession(options: AddSessionOptions = {}): Promise<AddSessionResult> {
  const schema = await appendSchemaTable({
    name: 'sessions',
    blocks: SESSIONS_TABLE_BLOCKS,
    imports: SCHEMA_IMPORTS,
    manualGuidance: 'the sessions table needs one. Run `bunx guren add session` again after adding db/schema.ts.',
  })

  // The scaffolded config imports `sessions` from db/schema.ts, so writing it
  // against a schema that does not exist ships an app that cannot compile.
  if (schema === 'no-schema') {
    return { files: [], schemaChanged: false }
  }

  // Skipped per file rather than thrown, so a re-run repairs whatever is
  // missing instead of aborting on the first file that already exists.
  const files = await writeScaffoldFiles(
    SCAFFOLD_PATHS.map((path) => scaffoldTemplateFile('session', path)),
    { ...options, skipExisting: true },
  )

  if (options.wire !== false) {
    await wireProviders([{ name: 'SessionProvider' }])
    await registerConsoleCommand('SessionsPruneCommand')
  }
  await patchEnvFiles()

  const migrationPending = options.migration !== false
    && !(await generateSchemaMigration('create_sessions_table', 'sessions'))

  consola.info('Next steps:')
  if (migrationPending) {
    consola.info('  • Generate the migration: bun run db:make')
  }
  consola.info('  • Run the migration: bun run db:migrate')
  consola.info('  • Set SESSION_DRIVER in .env (database or memory); config/session.ts declares them')
  consola.info('  • Schedule `sessions:prune` so expired rows are swept')

  return { files, schemaChanged: schema === 'appended' }
}

/**
 * The `SESSION_DRIVER` entry config/session.ts reads, in both env files: the
 * scaffolder copies `.env.example` to `.env` at create time, so writing only
 * the example leaves the file the app actually reads without the key.
 */
async function patchEnvFiles(): Promise<void> {
  const entry = `
# Which store config/session.ts uses. \`database\` needs the sessions table
# and its migration.
SESSION_DRIVER=database
# SESSION_DRIVER=memory
`

  for (const file of ENV_FILES) {
    const existing = await readIfExists(process.cwd(), file)
    // A missing .env is normal (it is gitignored); a missing .env.example is not
    // worth creating, since the app reads neither by this blueprint's doing.
    if (existing === null) continue
    if (/^\s*#?\s*SESSION_DRIVER=/m.test(existing)) {
      consola.info(`${file} already mentions SESSION_DRIVER — left unchanged.`)
      continue
    }

    await writeFile(resolve(process.cwd(), file), `${existing.trimEnd()}\n${entry}`, 'utf8')
    consola.info(`Added SESSION_DRIVER to ${file}.`)
  }
}
