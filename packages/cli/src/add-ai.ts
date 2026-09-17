import { consola } from 'consola'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ENV_SCHEMA_FILE } from './app-env'
import { CliError } from './cli-error'
import { cliDependencyRange } from './cli-manifest'
import { appDependsOn, fileExists, readIfExists } from './discovery'
import { appendEnvEntry } from './env-registrar'
import { generateSchemaMigration } from './make-migration'
import {
  appendSchemaTable,
  ensureMysqlImports,
  ensurePgImports,
  ensureSqliteImports,
  insertImport,
  type AppendSchemaTableResult,
  type SchemaDialect,
} from './patch-helpers'
import { checkPluginCompatibility, readCoreVersion, readPluginManifest } from './plugin-manifest'
import { wireConfig, wireProvider } from './provider-registrar'
import { scaffoldTemplateFile } from './scaffold-templates'
import { assertCwdUnsupported, runCommand, writeScaffoldFiles, type WriterOptions } from './utils'

export const AI_PLUGIN_PACKAGE = '@guren/plugin-ai'

interface AiProviderPreset {
  /** The AI SDK provider package; the gateway ships inside `ai` itself. */
  package?: string
  envKey: string
  envComment: string
}

const MISSING_KEY_FAILS = 'Unset, the app boots and the first prompt fails naming it.'

export const AI_PROVIDERS: Readonly<Record<string, AiProviderPreset>> = {
  anthropic: {
    package: '@ai-sdk/anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    envComment: `Anthropic API key for config/ai.ts. ${MISSING_KEY_FAILS}`,
  },
  openai: {
    package: '@ai-sdk/openai',
    envKey: 'OPENAI_API_KEY',
    envComment: `OpenAI API key for config/ai.ts. ${MISSING_KEY_FAILS}`,
  },
  gateway: {
    envKey: 'AI_GATEWAY_API_KEY',
    envComment: 'Vercel AI Gateway key for config/ai.ts. On Vercel, the deployment OIDC token is used when unset.',
  },
}

/**
 * The two tables `DatabaseConversationStore` reads (RFC 0029 §5), by column property name.
 * Ids are client-generated UUIDs, hence `varchar(36)` where MySQL indexes them. The unique
 * (conversation, position) index is what refuses two concurrent appends the same slot.
 */
const CONVERSATIONS_TABLE_BLOCKS: Record<SchemaDialect, string> = {
  pg: `export const aiConversations = pgTable('ai_conversations', {
  id: text('id').primaryKey(),
  agentName: text('agent_name').notNull(),
  owner: text('owner').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
})
`,
  sqlite: `export const aiConversations = sqliteTable('ai_conversations', {
  id: text('id').primaryKey(),
  agentName: text('agent_name').notNull(),
  owner: text('owner').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})
`,
  mysql: `export const aiConversations = mysqlTable('ai_conversations', {
  id: varchar('id', { length: 36 }).primaryKey(),
  agentName: varchar('agent_name', { length: 255 }).notNull(),
  owner: varchar('owner', { length: 255 }).notNull(),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
})
`,
}

const MESSAGES_TABLE_BLOCKS: Record<SchemaDialect, string> = {
  pg: `export const aiMessages = pgTable('ai_messages', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull().references(() => aiConversations.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  message: jsonb('message').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
}, (t) => [uniqueIndex('ai_messages_conversation_position_idx').on(t.conversationId, t.position)])
`,
  sqlite: `export const aiMessages = sqliteTable('ai_messages', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull().references(() => aiConversations.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  message: text('message', { mode: 'json' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
}, (t) => [uniqueIndex('ai_messages_conversation_position_idx').on(t.conversationId, t.position)])
`,
  mysql: `export const aiMessages = mysqlTable('ai_messages', {
  id: varchar('id', { length: 36 }).primaryKey(),
  conversationId: varchar('conversation_id', { length: 36 }).notNull().references(() => aiConversations.id, { onDelete: 'cascade' }),
  position: int('position').notNull(),
  message: json('message').notNull(),
  createdAt: timestamp('created_at').notNull(),
}, (t) => [uniqueIndex('ai_messages_conversation_position_idx').on(t.conversationId, t.position)])
`,
}

const CONVERSATIONS_SCHEMA_IMPORTS: Record<SchemaDialect, (content: string) => string> = {
  pg: (content) => ensurePgImports(content, ['pgTable', 'text', 'integer', 'jsonb', 'timestamp', 'uniqueIndex']),
  sqlite: (content) => ensureSqliteImports(content, ['sqliteTable', 'text', 'integer', 'uniqueIndex']),
  mysql: (content) => ensureMysqlImports(content, ['mysqlTable', 'varchar', 'int', 'json', 'timestamp', 'uniqueIndex']),
}

const CONVERSATIONS_IMPORT = "import { aiConversations, aiMessages } from '../db/schema'"
const CONVERSATIONS_ENTRY = "  conversations: { driver: 'database', conversations: aiConversations, messages: aiMessages },\n"

export interface AddAiOptions extends WriterOptions {
  provider?: string
  /** Add the conversation tables and the `database` store (default); false leaves conversations unconfigured. */
  conversations?: boolean
  /** Run `bun add` for the missing packages; otherwise print the command. */
  install?: boolean
}

/**
 * `guren add ai` (RFC 0029 §8): `config/ai.ts` for one provider, its key in
 * `config/env.ts` and the env files, `aiPlugin()` in `createApp({ providers })`,
 * the packages, and (with a `db/schema.ts`) the `ai_conversations` / `ai_messages` tables the
 * `database` conversation store reads, patched into `config/ai.ts` after its template (§5).
 */
export async function addAi(options: AddAiOptions = {}): Promise<string[]> {
  assertCwdUnsupported(options, 'guren add ai')
  const providerName = options.provider ?? 'anthropic'
  if (!Object.hasOwn(AI_PROVIDERS, providerName)) {
    throw new CliError(
      `Unknown AI provider "${providerName}". Choose one of: ${Object.keys(AI_PROVIDERS).join(', ')}.`,
    )
  }
  const provider = AI_PROVIDERS[providerName]!

  // A config definition reads only keys `config/env.ts` declares (RFC 0027 §2), and
  // `@guren/plugin-ai` offers no provider to fall back on.
  if (!(await fileExists(process.cwd(), ENV_SCHEMA_FILE))) {
    throw new CliError(
      `guren add ai writes config/ai.ts, which reads its API key from ${ENV_SCHEMA_FILE}, and this app has none. `
      + `Declare the environment with defineEnv() in ${ENV_SCHEMA_FILE} and pass it to createApp({ env }) first.`,
    )
  }

  // Before anything is written: a re-run that skipped the config would still add the
  // other provider's key and package, and the app would keep calling the first one.
  const existing = await readIfExists(process.cwd(), 'config/ai.ts')
  if (existing !== null && !options.force && !existing.includes(`default: '${providerName}'`)) {
    throw new CliError(
      `config/ai.ts already configures another default provider. Pass --force to replace it with ${providerName}, `
      + `or add a ${providerName} entry to its providers by hand.`,
    )
  }

  const schema = options.conversations === false ? undefined : await appendConversationTables()

  const created = await writeScaffoldFiles(
    [scaffoldTemplateFile(`ai/${providerName}`, 'config/ai.ts')],
    { ...options, skipExisting: true },
  )
  if (schema && schema.conversations !== 'no-schema') {
    await wireConversationStore(providerName)
  }

  await wireConfig('ai')
  await wireProvider('aiPlugin()', `import { aiPlugin } from '${AI_PLUGIN_PACKAGE}'`, {
    isRegistered: (entries) => entries.some((entry) => entry.startsWith('aiPlugin(')),
  })

  await appendEnvEntry(provider.envKey, `\n# ${provider.envComment}\n${provider.envKey}=\n`, {
    declare: { secret: true },
  })

  await installPackages(provider, Boolean(options.install))
  await warnIfCoreIncompatible()

  if (schema && (schema.conversations === 'appended' || schema.messages === 'appended')) {
    const generated = await generateSchemaMigration('create_ai_conversations_tables', 'AI conversation tables')
    consola.info(`Next: ${generated ? '' : 'bun run db:make, then '}bun run db:migrate to create ai_conversations and ai_messages.`)
  }
  return created
}

async function appendConversationTables(): Promise<{ conversations: AppendSchemaTableResult; messages?: AppendSchemaTableResult }> {
  const manualGuidance = 'conversations stay unconfigured. Run `bunx guren add ai` again after adding db/schema.ts to store them.'
  const conversations = await appendSchemaTable({
    name: 'aiConversations',
    blocks: CONVERSATIONS_TABLE_BLOCKS,
    imports: CONVERSATIONS_SCHEMA_IMPORTS,
    manualGuidance,
  })
  if (conversations === 'no-schema') return { conversations }
  // Second: its foreign key names aiConversations, which must be declared above it.
  const messages = await appendSchemaTable({
    name: 'aiMessages',
    blocks: MESSAGES_TABLE_BLOCKS,
    imports: CONVERSATIONS_SCHEMA_IMPORTS,
    manualGuidance,
  })
  return { conversations, messages }
}

/** Point `config/ai.ts` at the tables when it names no store and still has the shape the template gives it. */
async function wireConversationStore(providerName: string): Promise<void> {
  const source = await readIfExists(process.cwd(), 'config/ai.ts')
  if (source === null || /\bconversations\s*:/.test(source)) return

  const anchor = `  default: '${providerName}',\n`
  if (!source.includes(anchor)) {
    consola.warn(
      'config/ai.ts is not in the shape guren add ai writes, so conversations were not wired. Add '
      + "`conversations: { driver: 'database', conversations: aiConversations, messages: aiMessages }` "
      + `with ${CONVERSATIONS_IMPORT}.`,
    )
    return
  }
  // null when the import is already there.
  const withImport = insertImport(source, CONVERSATIONS_IMPORT) ?? source
  await writeFile(resolve(process.cwd(), 'config/ai.ts'), withImport.replace(anchor, `${anchor}${CONVERSATIONS_ENTRY}`), 'utf8')
  consola.info('Wired config/ai.ts to store conversations in ai_conversations and ai_messages.')
}

async function installPackages(provider: AiProviderPreset, install: boolean): Promise<void> {
  const names = [AI_PLUGIN_PACKAGE, 'ai', ...(provider.package ? [provider.package] : [])]
  const missing: string[] = []
  for (const name of names) {
    // An unreadable manifest answers null; installing then is what the user asked for.
    if ((await appDependsOn(process.cwd(), name)) === true) continue
    // The plugin unpinned: first-party, released with this CLI. The AI SDK packages at
    // the ranges `typecheck:templates` checks config/ai.ts against.
    missing.push(name === AI_PLUGIN_PACKAGE ? name : `${name}@${cliDependencyRange('devDependencies', name)}`)
  }
  if (missing.length === 0) return

  if (install) {
    await runCommand('bun', ['add', ...missing])
  } else {
    consola.info(`Run: bun add ${missing.join(' ')}`)
  }
}

/** The plugin depends on `@guren/core`; an app below its range installs a second copy beside its own. */
async function warnIfCoreIncompatible(): Promise<void> {
  const manifest = await readPluginManifest(AI_PLUGIN_PACKAGE)
  const result = manifest && checkPluginCompatibility(manifest, await readCoreVersion())
  if (result && !result.compatible) {
    consola.warn(
      `${AI_PLUGIN_PACKAGE} supports @guren/core ${result.range}, and this app has ${result.coreVersion}. `
      + 'Upgrade @guren/core, or the plugin runs against a second copy of it.',
    )
  }
}
