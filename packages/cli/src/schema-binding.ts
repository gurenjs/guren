/**
 * The one rule for "does this identifier name a table the app's schema
 * exports". Shared by every check that reads a `table:` out of a config —
 * `configureAttachments()` and the session store's `database` driver. A second
 * copy is how one check goes green while the other refuses the same table.
 */
import { dirname, relative, resolve } from 'node:path'
import type { Statement } from '@babel/types'
import type { SchemaTable } from './schema-parser'

/**
 * The import paths that mean "the app's Drizzle schema". Matched on the
 * specifier's tail so `@/db/schema`, `../db/schema`, `../../db/schema.js`,
 * and a module's `@/modules/billing/db/schema` all count.
 */
export const SCHEMA_SPECIFIER_PATTERN = /(^|\/)db\/schema(\.[jt]s)?$/

/**
 * Which schema a `db/schema` import lands on: the root schema (null) or a
 * module's. The existence question is per schema module — a module config
 * importing its *own* schema must not pass on the strength of a table the root
 * declares. Undefined for a specifier resolving outside both shapes.
 */
export function schemaModuleFor(cwd: string, filePath: string, specifier: string): string | null | undefined {
  const absolute = specifierBase(cwd, filePath, specifier)
  if (absolute === null) return undefined
  const rel = relative(cwd, absolute).replace(/\\/g, '/').replace(/\.[jt]s$/, '')
  if (rel === 'db/schema') return null
  const moduleMatch = /^modules\/([^/]+)\/db\/schema$/.exec(rel)
  if (moduleMatch) return moduleMatch[1]!
  return undefined
}

/**
 * Absolute path a specifier points at, before extension guessing: relative to the
 * importing file, or to the app root for the `@/` alias. Package specifiers yield `null`.
 * Pure string work, so a caller can rule an import out before touching the disk.
 */
export function specifierBase(cwd: string, fromFile: string, specifier: string): string | null {
  if (specifier.startsWith('.')) return resolve(dirname(fromFile), specifier)
  if (specifier.startsWith('@/')) return resolve(cwd, specifier.slice(2))
  return null
}

/** A module path as an import names it: `.js` in an import of a `.ts` file is the same module. */
export function withoutExtension(path: string): string {
  return path.replace(/\.[cm]?[jt]sx?$/u, '')
}

/**
 * The modules whose schema a file re-exports (`export *`, or a named value `export … from`). An
 * `import` of a module's schema puts none of its tables in the importer's own exports, which
 * is what drizzle-kit reads.
 */
export function reExportedSchemaModules(cwd: string, filePath: string, body: Statement[]): Set<string> {
  const modules = new Set<string>()
  for (const statement of body) {
    if (statement.type !== 'ExportAllDeclaration' && statement.type !== 'ExportNamedDeclaration') continue
    if (!statement.source || statement.exportKind === 'type') continue
    // `export * as billing from` exports one namespace object, not the tables.
    if (statement.type === 'ExportNamedDeclaration' && !statement.specifiers.some((specifier) => specifier.type === 'ExportSpecifier' && specifier.exportKind !== 'type')) continue
    const module = schemaModuleFor(cwd, filePath, statement.source.value)
    if (typeof module === 'string') modules.add(module)
  }
  return modules
}

export interface ImportEntry {
  source: string
  /** The *exported* name a local aliases; empty for default and namespace imports, which have none. */
  imported: string
  kind: 'named' | 'default' | 'namespace'
}

/** Local binding → where it came from and the exported name it aliases. */
export function importsByLocal(body: Statement[]): Map<string, ImportEntry> {
  const imports = new Map<string, ImportEntry>()
  for (const statement of body) {
    if (statement.type !== 'ImportDeclaration') continue
    const source = statement.source.value
    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportSpecifier') {
        const imported = specifier.imported
        imports.set(specifier.local.name, {
          source,
          imported: imported.type === 'Identifier' ? imported.name : imported.value,
          kind: 'named',
        })
      } else {
        imports.set(specifier.local.name, {
          source,
          imported: '',
          kind: specifier.type === 'ImportDefaultSpecifier' ? 'default' : 'namespace',
        })
      }
    }
  }
  return imports
}

export interface SchemaTableBinding {
  /** The exported name the schema is asked for — an alias resolves to what it aliases. */
  tableName: string
  source: string
  /** The schema module the import lands on: null for the root schema. */
  schemaModule: string | null
  declared: boolean
  /** The SQL name the schema gives that export, when it declares one the reader can name. */
  sqlName?: string
}

/**
 * Whether the schema declares a table by its SQL name, as the introspected app reports tables.
 * Only `true` is evidence: the static reader reads each root's `db/schema.ts` and nothing
 * `drizzle.config` adds, and names a `pgTableCreator()` or `pgSchema().table()` table wrongly or not at all.
 */
export function schemaDeclaresSqlTable(schemaTables: SchemaTable[], sqlName: string): boolean {
  return schemaTables.some((table) => table.tableName === sqlName)
}

/**
 * What `identifier` binds, judged against the schema module its import
 * resolves to. Undefined when the identifier is out of a static check's sight:
 * a table built inline, a default or namespace import, or a specifier that is
 * not a `db/schema` module.
 */
export function resolveSchemaTableBinding(options: {
  cwd: string
  filePath: string
  body: Statement[]
  identifier: string
  schemaTables: SchemaTable[]
}): SchemaTableBinding | undefined {
  const { cwd, filePath, body, identifier, schemaTables } = options
  const entry = importsByLocal(body).get(identifier)
  if (!entry?.imported || !SCHEMA_SPECIFIER_PATTERN.test(entry.source)) return undefined

  const schemaModule = schemaModuleFor(cwd, filePath, entry.source)
  if (schemaModule === undefined) return undefined

  const declared = schemaTables.find((table) => table.identifier === entry.imported && table.module === schemaModule)
  return {
    tableName: entry.imported,
    source: entry.source,
    schemaModule,
    declared: declared !== undefined,
    ...(declared?.tableName === undefined ? {} : { sqlName: declared.tableName }),
  }
}
