import { dirname, relative, resolve } from 'node:path'
import type { CallExpression, ObjectExpression, ObjectProperty } from '@babel/types'
import { walk } from './ast-walk'
import { check, type CheckResult } from './check-result'
import { collectFiles, listAppRoots } from './discovery'
import { DEFAULT_ROUTES_FILE, loadRouteDefinitions } from './load-routes'
import { parseModelSource } from './model-parser'
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
  /** Locals of `import * as ns from '@guren/core'` — `ns.configureAttachments(...)` counts as wiring too. */
  coreNamespaces: string[]
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
 * One reading of a file's imports for every consumer in this file. The
 * scaffolder preflight, the `guren check` rules, and the table check all
 * judge "does this file wire the attachments layer" through this single
 * scan — a second copy is how the two would start disagreeing about the
 * same app (`guren check` green while `make:feature --attach` refuses, or
 * worse).
 */
function scanAttachmentsImports(parsed: ParsedFile): AttachmentsImportScan {
  let configureLocal: string | null = null
  const coreNamespaces: string[] = []
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
        if (specifier.type === 'ImportNamespaceSpecifier' && declaration.source.value === '@guren/core') {
          coreNamespaces.push(specifier.local.name)
        }
        importsByLocal.set(specifier.local.name, {
          source: declaration.source.value,
          imported: '',
        })
      }
    }
  }
  return { configureLocal, coreNamespaces, importsByLocal }
}

/**
 * Whether the file makes a `configureAttachments()` call under its
 * `@guren/core` bindings — the named import (aliases included) or a
 * `core.configureAttachments()` member call on a namespace import. The
 * provenance rule of the table check below: a comment or a string merely
 * containing the name does not count.
 */
async function fileCallsConfigureAttachments(cache: ParseCache, filePath: string): Promise<boolean> {
  const source = await cache.source(filePath)
  if (!source || !source.includes('configureAttachments')) return false

  const parsed = await cache.get(filePath)
  if (!parsed) return false

  const { configureLocal, coreNamespaces } = scanAttachmentsImports(parsed)
  if (!configureLocal && coreNamespaces.length === 0) return false

  let found = false
  walk(parsed.ast, (node) => {
    if (found) return false
    if (node.type !== 'CallExpression') return
    const callee = (node as unknown as CallExpression).callee
    if (callee.type === 'Identifier' && callee.name === configureLocal) {
      found = true
    } else if (
      callee.type === 'MemberExpression' &&
      !callee.computed &&
      callee.object.type === 'Identifier' &&
      coreNamespaces.includes(callee.object.name) &&
      callee.property.type === 'Identifier' &&
      callee.property.name === 'configureAttachments'
    ) {
      found = true
    }
  })
  return found
}

/**
 * Whether the app (or one of its modules) wires the attachments layer: a
 * `configureAttachments` imported from `@guren/core` that is actually called.
 *
 * For scaffolders (`make:feature --attach`) that would otherwise emit models
 * whose `Attachable` statics all throw at first use — the guidance to run
 * `guren add attachments` first has to come from the scaffold, not from the
 * app's first crashed request. Positive evidence only, like the checks below:
 * a file that cannot be read or parsed contributes nothing, so an app this
 * cannot see into is refused rather than scaffolded broken. Delegates to the
 * same per-file predicate `checkAttachableModels` uses, so the scaffolder
 * and `guren check` cannot disagree about the same app.
 */
export async function appConfiguresAttachments(appRoot: string, cache: ParseCache): Promise<boolean> {
  for (const filePath of await discoverAttachmentsConfigFiles(appRoot)) {
    if (await fileCallsConfigureAttachments(cache, filePath)) return true
  }
  return false
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

    // The local name configureAttachments is bound to, and where each
    // imported identifier came from — the table's provenance is what makes
    // the check honest. Namespace-style configs
    // (`core.configureAttachments(...)`) stay out of this check's sight;
    // the presence checks above do see them.
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

/** What the delivery scan reads out of a `configureAttachments()` call. */
interface AttachmentsDeliveryScan {
  /** Config files (cwd-relative) whose options include a `delivery` property. */
  deliveryConfigs: string[]
  /** `serve: 'redirect'` disk declarations, per config file. */
  redirectDisks: Array<{ relPath: string; disk: string }>
}

function propertyNamed(node: ObjectExpression, name: string): ObjectProperty | undefined {
  for (const property of node.properties) {
    if (property.type !== 'ObjectProperty' || property.computed) continue
    const key = property.key
    if ((key.type === 'Identifier' && key.name === name) || (key.type === 'StringLiteral' && key.value === name)) {
      return property
    }
  }
  return undefined
}

async function scanAttachmentsDelivery(
  cwd: string,
  cache: ParseCache,
  files: string[],
): Promise<AttachmentsDeliveryScan> {
  const scan: AttachmentsDeliveryScan = { deliveryConfigs: [], redirectDisks: [] }
  for (const filePath of files) {
    const source = await cache.source(filePath)
    if (!source || !source.includes('configureAttachments')) continue
    const parsed = await cache.get(filePath)
    if (!parsed) continue
    const { configureLocal } = scanAttachmentsImports(parsed)
    if (!configureLocal) continue

    const relPath = relative(cwd, filePath)
    walk(parsed.ast, (node) => {
      if (node.type !== 'CallExpression') return
      const call = node as unknown as CallExpression
      if (call.callee.type !== 'Identifier' || call.callee.name !== configureLocal) return
      const argument = call.arguments[0]
      if (!argument || argument.type !== 'ObjectExpression') return

      const delivery = propertyNamed(argument, 'delivery')
      // `delivery: undefined` is the documented way to spell "off" inline.
      if (
        delivery &&
        !(delivery.value.type === 'Identifier' && delivery.value.name === 'undefined')
      ) {
        scan.deliveryConfigs.push(relPath)
      }

      const disks = propertyNamed(argument, 'disks')
      if (disks?.value.type !== 'ObjectExpression') return
      for (const entry of disks.value.properties) {
        if (entry.type !== 'ObjectProperty' || entry.computed) continue
        const diskName =
          entry.key.type === 'Identifier'
            ? entry.key.name
            : entry.key.type === 'StringLiteral'
              ? entry.key.value
              : null
        if (!diskName || entry.value.type !== 'ObjectExpression') continue
        const serve = propertyNamed(entry.value, 'serve')
        if (serve?.value.type === 'StringLiteral' && serve.value.value === 'redirect') {
          scan.redirectDisks.push({ relPath, disk: diskName })
        }
      }
    })
  }
  return scan
}

/**
 * The storage drivers the app's config declares, per disk name. Positive
 * evidence only: an entry counts when it is an object literal carrying a
 * string-literal `driver` inside a `disks: { ... }` map — the
 * `StorageConfig` shape. Anything dynamic stays out of the map (and out of
 * the redirect rule's sight).
 */
async function scanStorageDiskDrivers(cache: ParseCache, files: string[]): Promise<Map<string, string>> {
  const drivers = new Map<string, string>()
  for (const filePath of files) {
    const source = await cache.source(filePath)
    if (!source || !source.includes('driver')) continue
    const parsed = await cache.get(filePath)
    if (!parsed) continue
    walk(parsed.ast, (node) => {
      if (node.type !== 'ObjectProperty') return
      const property = node as unknown as ObjectProperty
      if (property.computed) return
      const key = property.key
      const isDisks =
        (key.type === 'Identifier' && key.name === 'disks') ||
        (key.type === 'StringLiteral' && key.value === 'disks')
      if (!isDisks || property.value.type !== 'ObjectExpression') return
      for (const entry of property.value.properties) {
        if (entry.type !== 'ObjectProperty' || entry.computed) continue
        const diskName =
          entry.key.type === 'Identifier'
            ? entry.key.name
            : entry.key.type === 'StringLiteral'
              ? entry.key.value
              : null
        if (!diskName || entry.value.type !== 'ObjectExpression') continue
        const driver = propertyNamed(entry.value, 'driver')
        if (driver?.value.type === 'StringLiteral' && !drivers.has(diskName)) {
          drivers.set(diskName, driver.value.value)
        }
      }
    })
  }
  return drivers
}

/** Storage drivers that can never presign — `serve: 'redirect'` on them downgrades at serve time. */
const NON_PRESIGNING_DRIVERS = new Set(['local', 'memory'])

/**
 * The RFC 0015 delivery-route wiring rules:
 *
 * 1. `configureAttachments({ delivery })` with no route registered by
 *    `registerAttachmentRoutes()` reachable from the mounted registrar —
 *    private attachment URLs would be minted that 404, and the failure is
 *    a uniform 404 by design, so nothing at runtime names the cause.
 *    Judged on *loaded* definitions (the registered controller), not the
 *    routes file's AST, for the same reason the route-contract check is:
 *    the registrar may delegate through helpers the AST cannot follow.
 * 2. `serve: 'redirect'` on a disk whose storage config declares a driver
 *    that can never presign (`local`, `memory`) — at serve time this
 *    downgrades to proxy with a warning (fail-closed), so the static gate
 *    is the only place the misconfiguration is visible before traffic.
 *    Positive evidence only: a disk whose driver cannot be read statically
 *    is skipped, not guessed at.
 */
export async function checkAttachmentsDelivery(options: {
  cwd: string
  cache: ParseCache
  /** Candidate config files, from {@link discoverAttachmentsConfigFiles}. */
  files: string[]
  /** Routes entry file, POSIX-relative to `cwd`. */
  routesFile?: string
  /** Test seam, like the route-contract check's: definitions to use instead of loading. */
  definitions?: Array<{ controller?: { name: string } }>
}): Promise<CheckResult[]> {
  const { cwd, cache, files } = options
  const scan = await scanAttachmentsDelivery(cwd, cache, files)
  if (scan.deliveryConfigs.length === 0 && scan.redirectDisks.length === 0) return []

  const results: CheckResult[] = []

  if (scan.deliveryConfigs.length > 0) {
    let definitions = options.definitions
    if (!definitions) {
      try {
        definitions = await loadRouteDefinitions(
          resolve(cwd, options.routesFile ?? DEFAULT_ROUTES_FILE),
          cwd,
        )
      } catch {
        // An app whose routes cannot load is reported by the route checks;
        // guessing about its delivery wiring on top would be noise.
        definitions = undefined
      }
    }
    if (definitions) {
      const mounted = definitions.some(
        (definition) => definition.controller?.name === 'AttachmentDeliveryController',
      )
      for (const relPath of scan.deliveryConfigs) {
        const key = `attachments-delivery:${relPath}`
        const title = 'Attachments delivery route'
        if (mounted) {
          results.push(
            check(key, title, 'pass', 'configureAttachments() enables delivery and registerAttachmentRoutes() is mounted.'),
          )
        } else {
          results.push(
            check(
              key,
              title,
              'fail',
              `configureAttachments() in ${relPath} enables delivery, but no route registered by `
                + `registerAttachmentRoutes() was found in the loaded route definitions. Private attachment `
                + `URLs would be minted that 404 — and every delivery failure is a uniform 404 by design, so `
                + `nothing at runtime names this cause.`,
              `Call registerAttachmentRoutes(router) from the route registrar your app mounts `
                + `(routes/web.ts), or remove the delivery option.`,
              relPath,
            ),
          )
        }
      }
    }
  }

  if (scan.redirectDisks.length > 0) {
    const drivers = await scanStorageDiskDrivers(cache, files)
    for (const { relPath, disk } of scan.redirectDisks) {
      const driver = drivers.get(disk)
      if (!driver) continue // not statically readable — skip, never guess
      const key = `attachments-serve-redirect:${relPath}:${disk}`
      const title = 'Attachments redirect disk'
      if (NON_PRESIGNING_DRIVERS.has(driver)) {
        results.push(
          check(
            key,
            title,
            'fail',
            `Disk '${disk}' is configured serve: 'redirect' in ${relPath}, but its storage driver `
              + `'${driver}' cannot presign. At serve time the route fails closed into proxying with a `
              + `warning, so the redirect you configured never happens.`,
            `Use serve: 'proxy' (or the default 'auto') for '${disk}', or move it to a driver that `
              + `declares presignedGet (S3, or R2 with presign credentials).`,
            relPath,
          ),
        )
      } else {
        results.push(
          check(key, title, 'pass', `Disk '${disk}' pairs serve: 'redirect' with driver '${driver}'.`),
        )
      }
    }
  }

  return results
}
