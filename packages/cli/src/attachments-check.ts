import { dirname, relative, resolve } from 'node:path'
import type { CallExpression } from '@babel/types'
import { walk } from './ast-walk'
import { check, type CheckResult } from './check-result'
import { collectFiles, listAppRoots } from './discovery'
import type { ParseCache, ParsedFile } from './parse-cache'
import { schemaPathFor, type SchemaTable } from './schema-parser'

/**
 * Where a `configureAttachments()` call can live: the documented home is
 * `config/attachments.ts`, but nothing enforces the filename, so every
 * config/, src/, and app/ source of the app and its modules is scanned (the
 * string pre-filter below keeps that cheap).
 */
export async function discoverAttachmentsConfigFiles(appRoot: string): Promise<string[]> {
  const roots = await listAppRoots(appRoot)
  const groups = await Promise.all(
    roots.flatMap((root) =>
      ['config', 'src', 'app'].map((dir) => collectFiles(resolve(root.dir, dir))),
    ),
  )
  return groups.flat().filter((file) => !/\.test\.[jt]sx?$/.test(file))
}

/**
 * The import paths that mean "the app's Drizzle schema". Matched on the
 * specifier's tail so `@/db/schema`, `../db/schema`, `../../db/schema.js`,
 * and a module's `@/modules/billing/db/schema` all count.
 */
const SCHEMA_SPECIFIER_PATTERN = /(^|\/)db\/schema(\.[jt]s)?$/

/**
 * Which schema a `db/schema` import actually lands on: the root schema
 * (null) or a module's. Resolved from the importing file's location for
 * relative specifiers and from the app root for `@/` ones, because the
 * existence question is per schema module — a module config importing its
 * *own* schema must not pass on the strength of a table the root declares.
 * Returns undefined for a specifier that resolves outside both shapes.
 */
function schemaModuleFor(cwd: string, filePath: string, specifier: string): string | null | undefined {
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

interface AttachmentsImportScan {
  /** The local binding `configureAttachments` (from `@guren/core`) is bound to, or null. */
  configureLocal: string | null
  /**
   * Local binding -> { where it came from, the *exported* name it aliases }.
   * The schema declares exported names, so an `import { attachments as att }`
   * must be judged by 'attachments', never by 'att'. Default and namespace
   * imports have no single exported name to judge against; recorded with an
   * empty `imported` so provenance tests can skip them.
   */
  importsByLocal: Map<string, { source: string; imported: string }>
}

/**
 * One reading of a file's imports for both consumers in this file. The
 * scaffolder preflight below and the `guren check` rule underneath judge
 * "does this file wire the attachments layer" through this single scan —
 * a second copy is how the two would start disagreeing about the same app
 * (`guren check` green while `make:feature --attach` refuses, or worse).
 */
function scanAttachmentsImports(parsed: ParsedFile): AttachmentsImportScan {
  let configureLocal: string | null = null
  const importsByLocal = new Map<string, { source: string; imported: string }>()
  for (const declaration of parsed.ast.program.body) {
    if (declaration.type !== 'ImportDeclaration') continue
    for (const specifier of declaration.specifiers) {
      if (specifier.type === 'ImportSpecifier') {
        const imported =
          specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value
        if (imported === 'configureAttachments' && declaration.source.value === '@guren/core') {
          configureLocal = specifier.local.name
        }
        importsByLocal.set(specifier.local.name, { source: declaration.source.value, imported })
      } else {
        importsByLocal.set(specifier.local.name, {
          source: declaration.source.value,
          imported: '',
        })
      }
    }
  }
  return { configureLocal, importsByLocal }
}

/**
 * Whether the app (or one of its modules) wires the attachments layer: a
 * `configureAttachments` imported from `@guren/core` that is actually called.
 *
 * For scaffolders (`make:feature --attach`) that would otherwise emit models
 * whose `Attachable` statics all throw at first use — the guidance to run
 * `guren add attachments` first has to come from the scaffold, not from the
 * app's first crashed request. Positive evidence only, like the check below:
 * a file that cannot be read or parsed contributes nothing, so an app this
 * cannot see into is refused rather than scaffolded broken.
 */
export async function appConfiguresAttachments(appRoot: string, cache: ParseCache): Promise<boolean> {
  for (const filePath of await discoverAttachmentsConfigFiles(appRoot)) {
    const source = await cache.source(filePath)
    if (!source || !source.includes('configureAttachments')) continue

    const parsed = await cache.get(filePath)
    if (!parsed) continue

    const { configureLocal } = scanAttachmentsImports(parsed)
    if (!configureLocal) continue

    let called = false
    walk(parsed.ast, (node) => {
      if (node.type !== 'CallExpression') return
      const call = node as unknown as CallExpression
      if (call.callee.type === 'Identifier' && call.callee.name === configureLocal) called = true
    })
    if (called) return true
  }
  return false
}

/**
 * Flags a `configureAttachments()` whose `table` is not a table the app's
 * `db/schema.ts` declares (RFC 0013 Part 3). The attachments layer takes the
 * table as `unknown` (the session-store convention), so nothing at typecheck
 * time notices a renamed or deleted schema export — the failure surfaces as
 * a runtime query error on the first attach.
 *
 * Judged conservatively, the way the other static checks are: the check
 * asserts only what it can positively read. A `table` that is not a plain
 * identifier, or one imported from somewhere other than a `db/schema`
 * module, is skipped rather than guessed at — a symbol this cannot trace is
 * not a missing one. Known limitation: a schema that renames on export
 * (`export { attachmentRows as attachments }`) is not resolved and reads as
 * missing — declare the table under its exported name instead.
 */
export async function checkAttachmentsConfig(options: {
  cwd: string
  cache: ParseCache
  files: string[]
  schemaTables: SchemaTable[]
}): Promise<CheckResult[]> {
  const { cwd, cache, files, schemaTables } = options
  const results: CheckResult[] = []

  for (const filePath of files) {
    // Cheap pre-filter: parsing every source file to find the one config
    // call would make this check pay for the whole app on every run.
    const source = await cache.source(filePath)
    if (!source || !source.includes('configureAttachments')) continue

    const parsed = await cache.get(filePath)
    if (!parsed) continue

    // The local name configureAttachments is bound to, and where each
    // imported identifier came from — the table's provenance is what makes
    // the check honest.
    const { configureLocal, importsByLocal } = scanAttachmentsImports(parsed)
    if (!configureLocal) continue

    const relPath = relative(cwd, filePath)
    walk(parsed.ast, (node) => {
      if (node.type !== 'CallExpression') return
      const call = node as unknown as CallExpression
      if (call.callee.type !== 'Identifier' || call.callee.name !== configureLocal) return

      const argument = call.arguments[0]
      if (!argument || argument.type !== 'ObjectExpression') return
      const tableProperty = argument.properties.find(
        (property) =>
          property.type === 'ObjectProperty' &&
          !property.computed &&
          ((property.key.type === 'Identifier' && property.key.name === 'table') ||
            (property.key.type === 'StringLiteral' && property.key.value === 'table')),
      )
      if (!tableProperty || tableProperty.type !== 'ObjectProperty') return
      if (tableProperty.value.type !== 'Identifier') return

      const localName = tableProperty.value.name
      const importEntry = importsByLocal.get(localName)
      // Only a named import from a db/schema module can be judged against
      // the parsed schema; anything else is out of this check's sight.
      if (!importEntry || !importEntry.imported || !SCHEMA_SPECIFIER_PATTERN.test(importEntry.source)) return

      const schemaModule = schemaModuleFor(cwd, filePath, importEntry.source)
      if (schemaModule === undefined) return

      const tableName = importEntry.imported
      const key = `attachments-config:${relPath}`
      const title = 'configureAttachments table'
      // Judged against the schema module the import resolves to, not the
      // union of every schema: a module config importing its own schema
      // must not pass because the root happens to declare the name.
      const declared = schemaTables.some(
        (table) => table.identifier === tableName && table.module === schemaModule,
      )
      if (declared) {
        results.push(
          check(key, title, 'pass', `configureAttachments() binds schema table '${tableName}'.`),
        )
        return
      }
      results.push(
        check(
          key,
          title,
          'fail',
          `configureAttachments() in ${relPath} binds '${tableName}' from ${importEntry.source}, but no schema `
            + `module declares a table with that export. The layer takes the table untyped, so this only `
            + `fails at runtime, on the first attach.`,
          `Export '${tableName}' from ${schemaPathFor(schemaModule)} (the attachments guide has the snippet `
            + `per dialect), or point configureAttachments() at the table your schema does export.`,
          relPath,
        ),
      )
    })
  }

  return results
}
