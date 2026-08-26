import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { consola } from 'consola'
import { collectFiles, fileExists, listAppRoots, readIfExists } from './discovery'
import {
  addImport,
  addToArrayArgument,
  detectSchemaDialect,
  ensureMysqlImports,
  ensurePgImports,
  ensureSqliteImports,
  insertImport,
  PATCH_REASONS,
  type SchemaDialect,
} from './patch-helpers'
import { wireProviders } from './provider-registrar'
import { loadScaffoldTemplate } from './scaffold-templates'
import { writeScaffoldFiles, type ScaffoldFileEntry, type WriterOptions } from './utils'

const CONSOLE_ENTRY = 'src/console.ts'

/**
 * The `attachments` table per dialect, matching the attachments guide's
 * snippets: morph columns under the ORM's `attachable` convention, a
 * JSON-capable `variants` column, and (on Postgres) `withTimezone`
 * timestamps per the `guren check` schema rule. The engine writes its own
 * timestamps, so the dialects without a portable default carry none.
 */
const ATTACHMENTS_TABLE_BLOCKS: Record<SchemaDialect, string> = {
  pg: `export const attachments = pgTable('attachments', {
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
`,
  sqlite: `export const attachments = sqliteTable('attachments', {
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
}, (t) => [index('attachments_attachable_idx').on(t.attachableType, t.attachableId, t.collection)])
`,
  mysql: `export const attachments = mysqlTable('attachments', {
  id: varchar('id', { length: 26 }).primaryKey(),
  attachableType: varchar('attachable_type', { length: 255 }).notNull(),
  attachableId: varchar('attachable_id', { length: 255 }).notNull(),
  collection: varchar('collection', { length: 255 }).notNull().default('default'),
  disk: varchar('disk', { length: 255 }).notNull(),
  path: varchar('path', { length: 1024 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  contentType: varchar('content_type', { length: 255 }).notNull(),
  size: int('size').notNull(),
  width: int('width'),
  height: int('height'),
  variants: json('variants').$type<Record<string, AttachmentVariantRecord>>(),
  placeholder: text('placeholder'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (t) => [index('attachments_attachable_idx').on(t.attachableType, t.attachableId, t.collection)])
`,
}

const SCHEMA_IMPORTS: Record<SchemaDialect, (content: string) => string> = {
  pg: (content) => ensurePgImports(content, ['pgTable', 'text', 'integer', 'jsonb', 'timestamp', 'index']),
  sqlite: (content) => ensureSqliteImports(content, ['sqliteTable', 'text', 'integer', 'index']),
  mysql: (content) =>
    ensureMysqlImports(content, ['mysqlTable', 'varchar', 'int', 'json', 'text', 'timestamp', 'index']),
}

const VARIANT_RECORD_IMPORT = "import type { AttachmentVariantRecord } from '@guren/core'"

/** `path` is both the template path under `templates/scaffold/attachments/` and the written app path. */
function attachmentsFile(path: string): ScaffoldFileEntry {
  return { path, contents: loadScaffoldTemplate(`attachments/${path}`) }
}

/**
 * Any exported `attachments` binding counts as "the app already has one":
 * builder spellings vary (`pgTable`, a pgSchema's `.table()`, re-exports),
 * and appending a second `export const attachments` next to any of them is
 * a compile error at best and a second physical table at worst.
 */
const ATTACHMENTS_TABLE_PATTERN = /\bexport\s+(?:const|let)\s+attachments\b|\bexport\s*\{[^}]*\battachments\b/

/**
 * `guren add attachments`: append the attachments table to `db/schema.ts`
 * (per dialect), write `config/attachments.ts` + `AttachmentsProvider`, wire
 * the provider, and register the `attachments:prune` console command.
 *
 * Works on API-only apps — nothing here renders a page. Requires a storage
 * manager; when the app has no `StorageProvider`, the storage blueprint is
 * installed first by the registry entry that calls this.
 */
export async function addAttachments(options: WriterOptions): Promise<string[]> {
  const created: string[] = []

  await patchSchema()

  // Skipped per file rather than thrown: a re-run (or a run after a partial
  // one) should repair whatever is missing — wire the provider, register the
  // command — not abort on the first file that already exists.
  const scaffolds = ['config/attachments.ts', 'app/Providers/AttachmentsProvider.ts'].map(attachmentsFile)
  const pending: ScaffoldFileEntry[] = []
  for (const entry of scaffolds) {
    if (!options.force && (await fileExists(process.cwd(), entry.path))) {
      consola.info(`${entry.path} already exists — left unchanged (use --force to overwrite).`)
    } else {
      pending.push(entry)
    }
  }
  created.push(...(await writeScaffoldFiles(pending, options)))

  await wireProviders([{ name: 'AttachmentsProvider' }])
  await registerPruneCommand()

  consola.info('Next steps:')
  consola.info('  • Generate and run the migration: bun run db:make && bun run db:migrate')
  consola.info("  • Declare collections on a model: class Post extends Attachable(defineModel(posts), { cover: hasOneAttached({ image: 'require' }) }) {}")
  consola.info('  • Register models that declare attachments in Model.morphMap so attachments:prune can verify their records')

  return created
}

async function patchSchema(): Promise<void> {
  const schemaRelative = 'db/schema.ts'
  const existing = await readIfExists(process.cwd(), schemaRelative)
  if (existing === null) {
    consola.warn(`No ${schemaRelative} found — add the attachments table from the attachments guide manually.`)
    return
  }

  if (ATTACHMENTS_TABLE_PATTERN.test(existing)) {
    consola.info(`${schemaRelative} already declares an attachments table — left unchanged.`)
    return
  }

  const dialect = detectSchemaDialect(existing)
  let content = SCHEMA_IMPORTS[dialect](existing)
  // Identifier-guarded: insertImport() only recognizes the exact statement,
  // so a schema that already imports the type among others would end up
  // with a duplicate binding.
  if (!content.includes('AttachmentVariantRecord')) {
    content = insertImport(content, VARIANT_RECORD_IMPORT) ?? content
  }
  content = `${content.trimEnd()}\n\n${ATTACHMENTS_TABLE_BLOCKS[dialect]}`

  await writeFile(resolve(process.cwd(), schemaRelative), content, 'utf8')
  consola.info(`Added the attachments table to ${schemaRelative} (${dialect}).`)
}

/**
 * Whether the app already binds a 'storage' service somewhere — the real
 * prerequisite question. The conventional file name alone answers it in
 * neither direction: a custom CloudStorageProvider binds storage without
 * that file, and installing a second manager over it would shadow it.
 */
export async function appBindsStorage(): Promise<boolean> {
  const roots = await listAppRoots(process.cwd())
  const groups = await Promise.all(
    roots.flatMap((root) => ['app', 'src'].map((dir) => collectFiles(resolve(root.dir, dir)))),
  )
  const bindingPattern = /\b(?:instance|singleton|bind)\(\s*['"]storage['"]/
  for (const filePath of groups.flat()) {
    const source = await readIfExists(process.cwd(), filePath)
    if (source && bindingPattern.test(source)) return true
  }
  return false
}

async function registerPruneCommand(): Promise<void> {
  const className = 'AttachmentsPruneCommand'
  const guidance = () => {
    consola.info(`Register the prune command in ${CONSOLE_ENTRY}:`)
    consola.info(`  import { ${className} } from '@guren/core'`)
    consola.info(`  kernel.registerMany([${className}])`)
  }

  if (!(await fileExists(process.cwd(), CONSOLE_ENTRY))) {
    consola.warn(`No ${CONSOLE_ENTRY} found — ${className} is not registered yet.`)
    guidance()
    return
  }

  // Read before patching: once the registration lands in the array, the
  // identifier is in the file, and "already imported?" can no longer be told
  // apart from "just registered". addImport() only recognizes the exact
  // statement, so an import merged into another '@guren/core' line would
  // otherwise get a duplicate binding appended.
  const beforePatch = (await readIfExists(process.cwd(), CONSOLE_ENTRY)) ?? ''
  const alreadyImported = beforePatch.includes(className)

  // Patch the registration before the import, so a failure here can't leave
  // an unused import behind (the same order make:command uses).
  const registration = await addToArrayArgument(CONSOLE_ENTRY, 'registerMany', className)

  if (!registration.modified && registration.reason !== PATCH_REASONS.alreadyPresent) {
    consola.warn(`Could not register ${className} automatically: ${registration.reason}`)
    guidance()
    return
  }

  if (!alreadyImported) {
    await addImport(CONSOLE_ENTRY, `import { ${className} } from '@guren/core'`)
  }

  if (registration.modified) {
    consola.success(`Registered ${className} in ${CONSOLE_ENTRY}`)
  } else {
    consola.info(`${className} is already registered in ${CONSOLE_ENTRY}`)
  }
}
