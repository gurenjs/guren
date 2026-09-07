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
  let absolute: string
  if (specifier.startsWith('@/')) {
    absolute = resolve(cwd, specifier.slice(2))
  } else if (specifier.startsWith('.')) {
    absolute = resolve(dirname(filePath), specifier)
  } else {
    return undefined
  }
  const rel = relative(cwd, absolute).replace(/\\/g, '/').replace(/\.[jt]s$/, '')
  if (rel === 'db/schema') return null
  const moduleMatch = /^modules\/([^/]+)\/db\/schema$/.exec(rel)
  if (moduleMatch) return moduleMatch[1]!
  return undefined
}

export interface ImportEntry {
  source: string
  /** The *exported* name a local aliases; empty for default and namespace imports, which have none. */
  imported: string
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
        })
      } else {
        imports.set(specifier.local.name, { source, imported: '' })
      }
    }
  }
  return imports
}

export interface SchemaTableBinding {
  /** The exported name the schema is asked for — an alias resolves to what it aliases. */
  tableName: string
  source: string
  declared: boolean
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

  return {
    tableName: entry.imported,
    source: entry.source,
    declared: schemaTables.some((table) => table.identifier === entry.imported && table.module === schemaModule),
  }
}
