import { relative, resolve } from 'node:path'
import type { CallExpression, ImportDeclaration, ObjectExpression } from '@babel/types'
import { walk } from './ast-walk'
import { check, type CheckResult } from './check-result'
import { collectFiles, listAppRoots } from './discovery'
import type { ParseCache } from './parse-cache'
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
 * not a missing one.
 */
export async function checkAttachmentsConfig(options: {
  cwd: string
  cache: ParseCache
  files: string[]
  schemaTables: SchemaTable[]
}): Promise<CheckResult[]> {
  const { cwd, cache, files, schemaTables } = options
  const results: CheckResult[] = []
  const declaredIdentifiers = new Set(schemaTables.map((table) => table.identifier))

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
    let configureLocal: string | null = null
    const importSpecifierByLocal = new Map<string, string>()
    for (const statement of parsed.ast.program.body) {
      if (statement.type !== 'ImportDeclaration') continue
      const declaration = statement as ImportDeclaration
      for (const specifier of declaration.specifiers) {
        if (specifier.type === 'ImportSpecifier') {
          const imported =
            specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value
          if (imported === 'configureAttachments' && declaration.source.value === '@guren/core') {
            configureLocal = specifier.local.name
          }
          importSpecifierByLocal.set(specifier.local.name, declaration.source.value)
        } else {
          importSpecifierByLocal.set(specifier.local.name, declaration.source.value)
        }
      }
    }
    if (!configureLocal) continue

    const relPath = relative(cwd, filePath)
    walk(parsed.ast, (node) => {
      if (node.type !== 'CallExpression') return
      const call = node as unknown as CallExpression
      if (call.callee.type !== 'Identifier' || call.callee.name !== configureLocal) return

      const argument = call.arguments[0]
      if (!argument || argument.type !== 'ObjectExpression') return
      const tableProperty = (argument as ObjectExpression).properties.find(
        (property) =>
          property.type === 'ObjectProperty' &&
          !property.computed &&
          ((property.key.type === 'Identifier' && property.key.name === 'table') ||
            (property.key.type === 'StringLiteral' && property.key.value === 'table')),
      )
      if (!tableProperty || tableProperty.type !== 'ObjectProperty') return
      if (tableProperty.value.type !== 'Identifier') return

      const tableName = tableProperty.value.name
      const importSource = importSpecifierByLocal.get(tableName)
      // Only a table imported from a db/schema module can be judged against
      // the parsed schema; anything else is out of this check's sight.
      if (!importSource || !SCHEMA_SPECIFIER_PATTERN.test(importSource)) return

      const declared = declaredIdentifiers.has(tableName)
      results.push(
        check(
          `attachments-config:${relPath}`,
          'configureAttachments table',
          declared ? 'pass' : 'fail',
          declared
            ? `configureAttachments() binds schema table '${tableName}'.`
            : `configureAttachments() in ${relPath} binds '${tableName}' from ${importSource}, but no schema `
              + `module declares a table with that export. The layer takes the table untyped, so this only `
              + `fails at runtime, on the first attach.`,
          declared
            ? undefined
            : `Export '${tableName}' from ${schemaPathFor(null)} (the attachments guide has the snippet per `
              + `dialect), or point configureAttachments() at the table your schema does export.`,
          declared ? undefined : relPath,
        ),
      )
    })
  }

  return results
}
