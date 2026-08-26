import { dirname, relative, resolve } from 'node:path'
import type { CallExpression, File } from '@babel/types'
import { walk } from './ast-walk'
import { check, type CheckResult } from './check-result'
import { collectFiles, listAppRoots } from './discovery'
import { parseModelSource } from './model-parser'
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

/**
 * The local bindings a file could call `configureAttachments` through: the
 * named-import local (aliases included) and any `import * as ns` namespace
 * locals — both restricted to `@guren/core`, the same provenance rule as
 * the table check below: a comment or a string merely containing the name
 * does not count. One resolver for both checks in this module, so the
 * binding rule cannot drift between them.
 */
function configureAttachmentsBindings(ast: File): { named: string | null; namespaces: string[] } {
  let named: string | null = null
  const namespaces: string[] = []
  for (const declaration of ast.program.body) {
    if (declaration.type !== 'ImportDeclaration' || declaration.source.value !== '@guren/core') continue
    for (const specifier of declaration.specifiers) {
      if (specifier.type === 'ImportNamespaceSpecifier') {
        namespaces.push(specifier.local.name)
        continue
      }
      if (specifier.type !== 'ImportSpecifier') continue
      const imported =
        specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value
      if (imported === 'configureAttachments') named = specifier.local.name
    }
  }
  return { named, namespaces }
}

/**
 * Whether the file makes a `configureAttachments()` call under its
 * `@guren/core` bindings — the named import or a `core.configureAttachments()`
 * member call on a namespace import.
 */
async function fileCallsConfigureAttachments(cache: ParseCache, filePath: string): Promise<boolean> {
  const source = await cache.source(filePath)
  if (!source || !source.includes('configureAttachments')) return false

  const parsed = await cache.get(filePath)
  if (!parsed) return false

  const bindings = configureAttachmentsBindings(parsed.ast)
  if (!bindings.named && bindings.namespaces.length === 0) return false

  let found = false
  walk(parsed.ast, (node) => {
    if (found) return false
    if (node.type !== 'CallExpression') return
    const callee = (node as unknown as CallExpression).callee
    if (callee.type === 'Identifier' && callee.name === bindings.named) {
      found = true
    } else if (
      callee.type === 'MemberExpression' &&
      !callee.computed &&
      callee.object.type === 'Identifier' &&
      bindings.namespaces.includes(callee.object.name) &&
      callee.property.type === 'Identifier' &&
      callee.property.name === 'configureAttachments'
    ) {
      found = true
    }
  })
  return found
}

/**
 * Flags models that mix in `Attachable(...)` in an app with no
 * `configureAttachments()` call anywhere (RFC 0013). The mixin's statics
 * resolve the configured layer lazily, at first use — so a model can build,
 * typecheck, and boot with no attachments config at all, and the miss only
 * surfaces as a runtime error on the first `attach()`.
 *
 * Presence-only on purpose: which table the config binds is the
 * {@link checkAttachmentsConfig} rule above; this one asks the prior
 * question of whether a config exists to bind anything.
 */
export async function checkAttachableModels(options: {
  cwd: string
  cache: ParseCache
  /** Model files, discovered once by the caller like the config `files` below. */
  files: string[]
  /** Candidate config files, from {@link discoverAttachmentsConfigFiles}. */
  configFiles: string[]
}): Promise<CheckResult[]> {
  const { cwd, cache, files, configFiles } = options

  // Same cheap pre-filter as the table check — only files naming the mixin
  // are worth parsing — with the "is this model Attachable" question itself
  // answered by the shared model projection rather than a second predicate.
  const sources = await Promise.all(files.map((file) => cache.source(file)))
  const attachableModels = files.flatMap((filePath, index) => {
    const source = sources[index]
    if (!source || !source.includes('Attachable')) return []
    const info = parseModelSource(source, filePath)
    if (!info || info.attachments === null) return []
    return [{ className: info.className, relPath: relative(cwd, filePath) }]
  })
  if (attachableModels.length === 0) return []

  let configured = false
  for (const filePath of configFiles) {
    if (await fileCallsConfigureAttachments(cache, filePath)) {
      configured = true
      break
    }
  }

  return attachableModels.map(({ className, relPath }) => {
    const key = `attachments-model:${relPath}`
    const title = 'Attachable model wiring'
    if (configured) {
      return check(key, title, 'pass', `${className} declares attachments and configureAttachments() is present.`)
    }
    return check(
      key,
      title,
      'fail',
      `${className} in ${relPath} mixes in Attachable(...), but no configureAttachments() call was found in `
        + `config/, src/, or app/. The mixin resolves the attachments layer at first use, so this only fails `
        + `at runtime, on the first attach.`,
      `Run \`guren add attachments\` to install the schema table, config, and provider, or add a `
        + `configureAttachments() call (config/attachments.ts is the documented home).`,
      relPath,
    )
  })
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

    // The local name configureAttachments is bound to (shared with the
    // presence check above), and where each imported identifier came from —
    // the table's provenance is what makes the check honest. Namespace-style
    // configs (`core.configureAttachments(...)`) stay out of this check's
    // sight; the presence check does see them.
    const configureLocal = configureAttachmentsBindings(parsed.ast).named
    // Local binding -> { where it came from, the *exported* name it aliases }.
    // The schema declares exported names, so an `import { attachments as att }`
    // must be judged by 'attachments', never by 'att'.
    const importsByLocal = new Map<string, { source: string; imported: string }>()
    for (const declaration of parsed.ast.program.body) {
      if (declaration.type !== 'ImportDeclaration') continue
      for (const specifier of declaration.specifiers) {
        if (specifier.type === 'ImportSpecifier') {
          const imported =
            specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value
          importsByLocal.set(specifier.local.name, { source: declaration.source.value, imported })
        } else {
          // Default and namespace imports have no single exported name to
          // judge against; recorded so the provenance test below can skip.
          importsByLocal.set(specifier.local.name, {
            source: declaration.source.value,
            imported: '',
          })
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
