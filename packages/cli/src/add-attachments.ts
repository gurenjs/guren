import { consola } from 'consola'
import { appBindsService } from './discovery'
import { registerConsoleCommand } from './console-registrar'
import {
  appendSchemaTable,
  ensureMysqlImports,
  ensurePgImports,
  ensureSqliteImports,
  type SchemaDialect,
} from './patch-helpers'
import { wireProviders } from './provider-registrar'
import { resolveRoutesEntry, wireRouteRegistrar } from './route-registrar'
import { scaffoldTemplateFile } from './scaffold-templates'
import { writeScaffoldFiles, type ScaffoldFileEntry, type WriterOptions } from './utils'

/**
 * The `attachments` table per dialect, matching the attachments guide. Postgres
 * uses `withTimezone` timestamps per the `guren check` schema rule; the engine
 * writes its own timestamps, so dialects without a portable default carry none.
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

function attachmentsFile(path: string): ScaffoldFileEntry {
  return scaffoldTemplateFile('attachments', path)
}


/**
 * `guren add attachments`: the schema table, `config/attachments.ts` +
 * `AttachmentsProvider`, the signed delivery route, and the `attachments:prune`
 * command. Works on API-only apps. Requires a storage manager — the registry
 * entry calling this installs the storage blueprint first when there is none.
 */
export async function addAttachments(options: WriterOptions): Promise<string[]> {
  const created: string[] = []

  await patchSchema()

  // Skipped per file rather than thrown, so a re-run repairs whatever is
  // missing instead of aborting on the first file that already exists.
  const scaffolds = ['config/attachments.ts', 'app/Providers/AttachmentsProvider.ts'].map(attachmentsFile)
  created.push(...(await writeScaffoldFiles(scaffolds, { ...options, skipExisting: true })))

  await wireProviders([{ name: 'AttachmentsProvider' }])
  await registerDeliveryRoute()
  await registerConsoleCommand('AttachmentsPruneCommand')

  consola.info('Next steps:')
  consola.info('  • Generate and run the migration: bun run db:make && bun run db:migrate')
  consola.info('  • Uploads are stored on the private `local` disk and served through the signed delivery route — keep them out of public/, which is served statically')
  consola.info("  • Declare collections on a model: class Post extends Attachable(defineModel(posts), { cover: hasOneAttached({ image: 'require' }) }) {}")
  consola.info('  • Register models that declare attachments in Model.morphMap so attachments:prune can verify their records')

  return created
}

/**
 * Mount the signed delivery route `config/attachments.ts` configures. Uploads go
 * to a private disk whose URLs point at this route, so an unmounted one 404s
 * (see the `attachments-delivery` rule in attachments-check.ts). The entry file
 * is probed, not assumed: an API-only app ships `routes/api.ts` and no web entry.
 */
async function registerDeliveryRoute(): Promise<void> {
  const routesFile = await resolveRoutesEntry(process.cwd())

  if (routesFile === null) {
    consola.warn(
      'No routes entry found — call registerAttachmentRoutes(router) from your route registrar, '
      + 'or attachment URLs will 404.',
    )
    return
  }

  await wireRouteRegistrar(
    'registerAttachmentRoutes',
    "import { registerAttachmentRoutes } from '@guren/core'",
    routesFile,
  )
}

async function patchSchema(): Promise<void> {
  await appendSchemaTable({
    name: 'attachments',
    blocks: ATTACHMENTS_TABLE_BLOCKS,
    imports: SCHEMA_IMPORTS,
    extraImport: VARIANT_RECORD_IMPORT,
    manualGuidance: 'add the attachments table from the attachments guide manually.',
  })
}

/**
 * Whether the app already binds a 'storage' service. The conventional file name
 * answers this in neither direction: a custom provider binds storage without
 * that file, and installing a second manager would shadow it.
 */
export async function appBindsStorage(): Promise<boolean> {
  return appBindsService('storage')
}

