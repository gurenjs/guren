import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { consola } from 'consola'
import { fileExists, readIfExists } from './discovery'
import { makeMigration } from './make-migration'
import {
  addImport,
  addToArrayArgument,
  detectSchemaDialect,
  ensureMysqlImports,
  ensurePgImports,
  ensureSqliteImports,
  PATCH_REASONS,
  type SchemaDialect,
} from './patch-helpers'
import { wireProviders } from './provider-registrar'
import { scaffoldTemplateFile } from './scaffold-templates'
import { writeScaffoldFiles, type ScaffoldFileEntry, type WriterOptions } from './utils'

const CONSOLE_ENTRY = 'src/console.ts'
const SCHEMA_FILE = 'db/schema.ts'
const ENV_EXAMPLE = '.env.example'

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

/**
 * Any exported `sessions` binding counts as one the app already has: builder
 * spellings vary, and appending a second is a compile error at best and a
 * second physical table at worst.
 */
const SESSIONS_TABLE_PATTERN = /\bexport\s+(?:const|let)\s+sessions\b|\bexport\s*\{[^}]*\bsessions\b/

const SCAFFOLD_PATHS = ['config/session.ts', 'app/Providers/SessionProvider.ts'] as const

export interface AddSessionOptions extends WriterOptions {
  /** Leave the migration to the caller, which is generating one over the same schema. */
  migration?: boolean
}

/** Whether the app already has the session config this blueprint writes. */
export async function appConfiguresSessions(cwd: string = process.cwd()): Promise<boolean> {
  return fileExists(cwd, 'config/session.ts')
}

/**
 * `guren add session`: the `sessions` schema table and its migration,
 * `config/session.ts` + `SessionProvider`, the `SESSION_DRIVER` env entry, and
 * the `sessions:prune` command. Without it an app's sessions live in process
 * memory, which is correct on one long-lived server and drops every login on
 * Workers, Lambda and Vercel (RFC 0020).
 */
export async function addSession(options: AddSessionOptions): Promise<string[]> {
  const created: string[] = []

  await patchSchema()

  // Skipped per file rather than thrown, so a re-run repairs whatever is
  // missing instead of aborting on the first file that already exists.
  const pending: ScaffoldFileEntry[] = []
  for (const path of SCAFFOLD_PATHS) {
    if (!options.force && (await fileExists(process.cwd(), path))) {
      consola.info(`${path} already exists — left unchanged (use --force to overwrite).`)
    } else {
      pending.push(scaffoldTemplateFile('session', path))
    }
  }
  created.push(...(await writeScaffoldFiles(pending, options)))

  await wireProviders([{ name: 'SessionProvider' }])
  await registerPruneCommand()
  await patchEnvExample()
  const migrationGenerated = options.migration === false || (await generateSessionsMigration())

  consola.info('Next steps:')
  if (!migrationGenerated) {
    consola.info('  • Generate the migration: bun run db:make')
  }
  consola.info('  • Run the migration: bun run db:migrate')
  consola.info('  • Set SESSION_DRIVER in .env (database, memory, or redis); config/session.ts declares them')
  consola.info('  • Schedule `sessions:prune` so expired rows are swept')

  return created
}

async function patchSchema(): Promise<void> {
  const existing = await readIfExists(process.cwd(), SCHEMA_FILE)
  if (existing === null) {
    consola.warn(`No ${SCHEMA_FILE} found — add the sessions table from the authentication guide manually.`)
    return
  }

  if (SESSIONS_TABLE_PATTERN.test(existing)) {
    consola.info(`${SCHEMA_FILE} already declares a sessions table — left unchanged.`)
    return
  }

  const dialect = detectSchemaDialect(existing)
  const content = `${SCHEMA_IMPORTS[dialect](existing).trimEnd()}\n\n${SESSIONS_TABLE_BLOCKS[dialect]}`

  await writeFile(resolve(process.cwd(), SCHEMA_FILE), content, 'utf8')
  consola.info(`Added the sessions table to ${SCHEMA_FILE} (${dialect}).`)
}

async function registerPruneCommand(): Promise<void> {
  const className = 'SessionsPruneCommand'
  const guidance = (): void => {
    consola.info(`Register the prune command in ${CONSOLE_ENTRY}:`)
    consola.info(`  import { ${className} } from '@guren/core'`)
    consola.info(`  kernel.registerMany([${className}])`)
  }

  if (!(await fileExists(process.cwd(), CONSOLE_ENTRY))) {
    consola.warn(`No ${CONSOLE_ENTRY} found — ${className} is not registered yet.`)
    guidance()
    return
  }

  // Read before patching: once the registration lands, "already imported?"
  // cannot be told from "just registered", and addImport() recognizes only the
  // exact statement, so a merged '@guren/core' line would get a duplicate.
  const beforePatch = (await readIfExists(process.cwd(), CONSOLE_ENTRY)) ?? ''
  const alreadyImported = beforePatch.includes(className)

  // Patch the registration before the import, so a failure here cannot leave
  // an unused import behind (the same order make:command uses).
  const registration = await addToArrayArgument(CONSOLE_ENTRY, 'registerMany', className)
  if (!registration.modified && registration.reason !== PATCH_REASONS.alreadyPresent) {
    consola.warn(`Could not register ${className} automatically: ${registration.reason}`)
    guidance()
    return
  }

  if (!alreadyImported) {
    const imported = await addImport(CONSOLE_ENTRY, `import { ${className} } from '@guren/core'`)
    if (!imported.modified && imported.reason !== PATCH_REASONS.alreadyPresent) {
      consola.warn(`Could not import ${className} automatically: ${imported.reason}`)
      guidance()
      return
    }
  }

  consola.success(`Registered ${className} in ${CONSOLE_ENTRY}.`)
}

/**
 * The `SESSION_DRIVER` entry config/session.ts reads. Appended rather than
 * rewritten: an app may already carry a value, and the scaffolded .env.example
 * ships none until this blueprint runs.
 */
async function patchEnvExample(): Promise<void> {
  const existing = await readIfExists(process.cwd(), ENV_EXAMPLE)
  if (existing === null) {
    consola.info('No .env.example found — set SESSION_DRIVER=database in your environment.')
    return
  }

  if (/^\s*#?\s*SESSION_DRIVER=/m.test(existing)) {
    consola.info('.env.example already mentions SESSION_DRIVER — left unchanged.')
    return
  }

  const entry = [
    '',
    '# Which store config/session.ts uses. `database` needs the sessions table',
    '# and its migration; `redis` needs REDIS_URL.',
    'SESSION_DRIVER=database',
    '# SESSION_DRIVER=memory',
    '# SESSION_DRIVER=redis',
    '',
  ].join('\n')

  await writeFile(resolve(process.cwd(), ENV_EXAMPLE), `${existing.trimEnd()}\n${entry}`, 'utf8')
  consola.info('Added SESSION_DRIVER to .env.example.')
}

async function generateSessionsMigration(): Promise<boolean> {
  if (!existsSync(resolve(process.cwd(), 'node_modules', 'drizzle-kit'))) {
    consola.info('drizzle-kit is not installed — run `bun run db:make` after `bun install` to generate the sessions migration.')
    return false
  }

  try {
    await makeMigration({ name: 'create_sessions_table' })
    consola.success('Generated sessions table migration via drizzle-kit.')
    return true
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    consola.warn(`Could not generate the sessions migration automatically (${reason}).`)
    consola.info('Run `bun run db:make` (drizzle-kit generate) to create it from db/schema.ts.')
    return false
  }
}
