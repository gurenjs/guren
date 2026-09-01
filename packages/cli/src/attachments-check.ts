import { dirname, relative, resolve, sep } from 'node:path'
import type { CallExpression, ObjectExpression, ObjectProperty } from '@babel/types'
import { AttachmentDeliveryController, type RouteDefinition } from '@guren/core'
import { literalString, memberKeyName, objectLiteral, unwrapTypeAssertion, walk } from './ast-walk'
import { check, type CheckResult } from './check-result'
import { collectFiles, fileExists, listAppRoots } from './discovery'
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

      const argument = objectLiteral(call.arguments[0])
      if (!argument) return
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

/**
 * Visit every `configureAttachments()` call in `files` whose options are an
 * inline object — the named import (aliases included) and the
 * `core.configureAttachments()` namespace form alike, so a config style the
 * presence checks accept is never invisible to the rules built on this.
 */
async function forEachConfigureAttachmentsCall(
  cache: ParseCache,
  files: string[],
  visit: (context: { filePath: string; options: ObjectExpression }) => void,
): Promise<void> {
  for (const filePath of files) {
    const source = await cache.source(filePath)
    if (!source || !source.includes('configureAttachments')) continue
    const parsed = await cache.get(filePath)
    if (!parsed) continue
    const { configureLocal, coreNamespaces } = scanAttachmentsImports(parsed)
    if (!configureLocal && coreNamespaces.length === 0) continue
    walk(parsed.ast, (node) => {
      if (node.type !== 'CallExpression') return
      const call = node as unknown as CallExpression
      const callee = call.callee
      const matches =
        (callee.type === 'Identifier' && callee.name === configureLocal) ||
        (callee.type === 'MemberExpression' &&
          !callee.computed &&
          callee.object.type === 'Identifier' &&
          coreNamespaces.includes(callee.object.name) &&
          callee.property.type === 'Identifier' &&
          callee.property.name === 'configureAttachments')
      if (!matches) return
      const argument = objectLiteral(call.arguments[0])
      if (!argument) return
      visit({ filePath, options: argument })
    })
  }
}

function propertyNamed(node: ObjectExpression, name: string): ObjectProperty | undefined {
  return node.properties.find(
    (property): property is ObjectProperty =>
      property.type === 'ObjectProperty' && memberKeyName(property) === name,
  )
}

/** `[diskName, value]` pairs of a disks map whose entries are object literals. */
function* diskObjectEntries(disks: ObjectExpression): Generator<[string, ObjectExpression]> {
  for (const entry of disks.properties) {
    if (entry.type !== 'ObjectProperty') continue
    const disk = memberKeyName(entry)
    const config = objectLiteral(entry.value)
    if (!disk || !config) continue
    yield [disk, config]
  }
}

/** What the delivery scan reads out of the app's `configureAttachments()` calls. */
interface AttachmentsDeliveryScan {
  /** Config files (cwd-relative, deduplicated) whose options include `delivery`. */
  deliveryConfigs: string[]
  /** The delivery route names in play (configured literals, or the default). */
  routeNames: Set<string>
  /** `serve: 'redirect'` disk declarations, deduplicated per config file. */
  redirectDisks: Array<{ relPath: string; disk: string }>
}

const DEFAULT_DELIVERY_ROUTE_NAME = 'attachments.show'

async function scanAttachmentsDelivery(
  cwd: string,
  cache: ParseCache,
  files: string[],
): Promise<AttachmentsDeliveryScan> {
  const deliveryConfigs = new Set<string>()
  const routeNames = new Set<string>()
  const redirectDisks = new Set<string>()

  await forEachConfigureAttachmentsCall(cache, files, ({ filePath, options }) => {
    const relPath = relative(cwd, filePath)

    const delivery = propertyNamed(options, 'delivery')
    // A literal `delivery: undefined` is the documented inline "off".
    if (delivery && !(delivery.value.type === 'Identifier' && delivery.value.name === 'undefined')) {
      deliveryConfigs.add(relPath)
      const deliveryOptions = objectLiteral(delivery.value)
      const routeName = deliveryOptions ? literalString(propertyNamed(deliveryOptions, 'routeName')?.value) : null
      routeNames.add(routeName ?? DEFAULT_DELIVERY_ROUTE_NAME)
    }

    const disks = objectLiteral(propertyNamed(options, 'disks')?.value)
    if (!disks) return
    for (const [disk, config] of diskObjectEntries(disks)) {
      if (literalString(propertyNamed(config, 'serve')?.value) === 'redirect') {
        redirectDisks.add(`${relPath}\u0000${disk}`)
      }
    }
  })

  return {
    deliveryConfigs: [...deliveryConfigs],
    routeNames,
    redirectDisks: [...redirectDisks].map((key) => {
      const [relPath, disk] = key.split('\u0000')
      return { relPath: relPath!, disk: disk! }
    }),
  }
}

/**
 * What a `disks` map declares about one disk. Each field is read
 * independently, and `null` means "this scan cannot say": absent, not a
 * string literal, or declared two different ways in two places. Kept
 * per-field rather than per-disk so that conflicting evidence about one
 * property never silently withdraws a rule that reads the other.
 */
interface StorageDiskDeclaration {
  /** `driver: 'local' | 's3' | …` */
  driver?: string | null
  /** `root: './public/storage'` — the local driver's base directory. */
  root?: string | null
}

/**
 * The storage disks the app's config declares, per disk name. Positive
 * evidence only, in both directions: a field counts when a `disks`
 * property carries (inline, or through a same-file `const` the property
 * references — the `StorageProvider` scaffold's shape) an object literal
 * with a string-literal value for it; two sources disagreeing about one
 * field makes that field unreadable (`null`) rather than first-match-wins.
 * The scan cannot prove a map reaches `createStorageManager()`, so the
 * candidate set must keep sweeping all of config/, src/, and app/ — a
 * discovery narrowed to attachments configs would silently blind the
 * redirect rule (the runCheck-level test pins this).
 */
async function scanStorageDisks(cache: ParseCache, files: string[]): Promise<Map<string, StorageDiskDeclaration>> {
  const disks = new Map<string, StorageDiskDeclaration>()
  const record = (disk: string, field: keyof StorageDiskDeclaration, value: string) => {
    const existing = disks.get(disk) ?? {}
    // Never declared adopts the value; a second, disagreeing declaration
    // makes the field unreadable — and stays that way, since a sticky `null`
    // is never equal to a later value either.
    if (existing[field] === undefined) existing[field] = value
    else if (existing[field] !== value) existing[field] = null
    disks.set(disk, existing)
  }

  for (const filePath of files) {
    const source = await cache.source(filePath)
    if (!source || !source.includes('disks')) continue
    const parsed = await cache.get(filePath)
    if (!parsed) continue

    // Same-file `const disks = { ... }` bindings, for the shorthand form.
    const constObjects = new Map<string, ObjectExpression>()
    for (const statement of parsed.ast.program.body) {
      if (statement.type !== 'VariableDeclaration') continue
      for (const declarator of statement.declarations) {
        const init = objectLiteral(declarator.init)
        if (declarator.id.type === 'Identifier' && init) {
          constObjects.set(declarator.id.name, init)
        }
      }
    }

    walk(parsed.ast, (node) => {
      if (node.type !== 'ObjectProperty') return
      const property = node as unknown as ObjectProperty
      if (memberKeyName(property) !== 'disks') return
      const propertyValue = unwrapTypeAssertion(property.value)
      const value =
        objectLiteral(propertyValue) ??
        (propertyValue.type === 'Identifier' ? constObjects.get(propertyValue.name) : undefined)
      if (!value) return
      for (const [disk, config] of diskObjectEntries(value)) {
        const driver = literalString(propertyNamed(config, 'driver')?.value)
        if (driver) record(disk, 'driver', driver)
        const root = literalString(propertyNamed(config, 'root')?.value)
        if (root) record(disk, 'root', root)
      }
    })
  }
  return disks
}

/** Is `candidate` the directory `root`, or a path below it? Lexical: neither side need exist yet. */
function isAtOrWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep)
}

/**
 * The disk new attachments are written to, per config file — the `disk`
 * option, which is required and names one entry of the storage manager's
 * map.
 */
async function scanAttachmentsDefaultDisks(
  cwd: string,
  cache: ParseCache,
  files: string[],
): Promise<Array<{ relPath: string; disk: string }>> {
  const found: Array<{ relPath: string; disk: string }> = []
  await forEachConfigureAttachmentsCall(cache, files, ({ filePath, options }) => {
    const disk = literalString(propertyNamed(options, 'disk')?.value)
    if (!disk) return
    const relPath = relative(cwd, filePath)
    if (!found.some((entry) => entry.relPath === relPath && entry.disk === disk)) {
      found.push({ relPath, disk })
    }
  })
  return found
}

/**
 * `configureAttachments({ disk })` pointing at a local disk rooted inside
 * the app's public directory.
 *
 * Uploaded bytes then sit in the statically served tree, and the root asset
 * server returns them by extension with the content type that matches: an
 * uploaded `.svg` comes back as `image/svg+xml`, inline, and its script runs
 * on the app's own origin with the app's own cookies. The attachments
 * delivery route exists precisely to avoid this — it serves only an
 * allowlist of types inline, forces a download for the rest, and adds
 * nosniff plus a sandbox CSP — but a disk rooted under `public/` is reachable
 * without ever going through it, so no amount of delivery configuration
 * repairs this shape. Only moving the root does.
 *
 * This is the rule that tells an app scaffolded before the default changed
 * that it is still in the old shape; nothing at runtime reports it, because
 * serving the file *is* the intended behaviour of the disk it was put on.
 *
 * Positive evidence only, and deliberately narrow — it fires when the
 * driver is literally `local` and the declared `root` is at or below
 * `<cwd>/public`. An app that relocated its public directory, or that
 * computes either value, is not judged rather than guessed at: this rule
 * fails a build, so a false positive costs more than the miss.
 */
export async function checkAttachmentsPublicDisk(options: {
  cwd: string
  cache: ParseCache
  /** Candidate config files, from {@link discoverAttachmentsConfigFiles}. */
  files: string[]
}): Promise<CheckResult[]> {
  const { cwd, cache, files } = options
  const defaults = await scanAttachmentsDefaultDisks(cwd, cache, files)
  if (defaults.length === 0) return []

  const declarations = await scanStorageDisks(cache, files)
  // The statically served directory, by convention and by the framework's own
  // default (`publicPath` defaults to `../public` relative to the server module).
  const publicDir = resolve(cwd, 'public')
  const results: CheckResult[] = []

  for (const { relPath, disk } of defaults) {
    const declaration = declarations.get(disk)
    // Unreadable in either field: skip, never guess.
    if (!declaration || declaration.root == null) continue
    if (!KNOWN_FILESYSTEM_DRIVERS.has(declaration.driver ?? '')) continue

    const key = `attachments-public-disk:${relPath}:${disk}`
    const title = 'Attachments disk outside public/'
    const root = resolve(cwd, declaration.root)

    if (isAtOrWithin(publicDir, root)) {
      results.push(
        check(
          key,
          title,
          'fail',
          `configureAttachments() in ${relPath} stores new attachments on disk '${disk}', which is ` +
            `rooted at ${declaration.root} — inside the public directory the app serves statically. ` +
            `An uploaded .svg or .html is then reachable as a static asset and renders on the app's ` +
            `own origin, which is stored XSS; the attachments delivery route cannot intervene, ` +
            `because nothing has to go through it to reach the file.`,
          `Point disk at a disk rooted outside public/ (the scaffold's 'local', at ./storage/app), ` +
            `declare it private in disks, and serve it through delivery: {} plus ` +
            `registerAttachmentRoutes(router) in your route registrar.`,
          relPath,
        ),
      )
    } else {
      results.push(
        check(key, title, 'pass', `Attachments disk '${disk}' is rooted outside public/ (${declaration.root}).`),
      )
    }
  }

  return results
}

/**
 * Twinned with `StorageDriverCapabilities.presignedGet` in @guren/server —
 * the runtime consults `disk.capabilities?.presignedGet === true`, which
 * `S3Driver` declares, `LocalDriver`/`MemoryDriver` never do, and
 * `R2Driver` declares only when `presign` credentials exist. A driver name
 * in neither set is a capability this scan cannot read: skipped, never
 * guessed in either direction (an unknown name passed off as green would
 * fail open; failed, it would false-flag every custom presigning driver).
 */
const KNOWN_NON_PRESIGNING_DRIVERS = new Set(['local', 'memory'])
const KNOWN_PRESIGNING_DRIVERS = new Set(['s3'])

/**
 * Drivers whose `root` is a filesystem path, so that "is this disk inside
 * public/?" is a question about it at all. Same never-guess policy as the
 * presigning sets above: a driver name outside this set is a disk this scan
 * cannot place, skipped rather than judged.
 *
 * Unlike those, this has no runtime twin to mirror — `root` is meaningful
 * only to `LocalDriver`, and nothing at serve time would read a capability
 * flag for it. A named set rather than a bare `!== 'local'` so that the
 * file's three driver judgements are found together.
 */
const KNOWN_FILESYSTEM_DRIVERS = new Set(['local'])

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
 * 2. A delivery route name claimed by more than one loaded definition —
 *    `Router.name()` silently overwrites duplicates.
 * 3. `serve: 'redirect'` on a disk whose storage config declares a driver
 *    that can never presign — at serve time this downgrades to proxy with
 *    a warning (fail-closed), so this static gate is the only place the
 *    misconfiguration is visible before traffic.
 */
export async function checkAttachmentsDelivery(options: {
  cwd: string
  cache: ParseCache
  /** Candidate config files, from {@link discoverAttachmentsConfigFiles}. */
  files: string[]
  /** Routes entry file, POSIX-relative to `cwd`. */
  routesFile?: string
  /** Test seam, like the route-contract check's: definitions to use instead of loading. */
  definitions?: RouteDefinition[]
}): Promise<CheckResult[]> {
  const { cwd, cache, files } = options
  const scan = await scanAttachmentsDelivery(cwd, cache, files)
  const results: CheckResult[] = []

  if (scan.deliveryConfigs.length > 0) {
    const routesFile = options.routesFile ?? DEFAULT_ROUTES_FILE
    let definitions = options.definitions
    let routesEntryMissing = false
    if (!definitions) {
      if (await fileExists(cwd, routesFile)) {
        try {
          definitions = await loadRouteDefinitions(resolve(cwd, routesFile), cwd)
        } catch {
          // An app whose routes cannot load is reported by the route
          // checks; guessing about its delivery wiring on top would be
          // noise. `definitions` stays undefined and the rule stays quiet.
        }
      } else {
        // No routes entry at all is positive evidence: nothing can have
        // mounted the route.
        routesEntryMissing = true
      }
    }

    const mounted =
      definitions?.some(
        (definition) => definition.controller?.name === AttachmentDeliveryController.name,
      ) ?? false

    if (mounted) {
      results.push(
        check(
          'attachments-delivery',
          'Attachments delivery route',
          'pass',
          'configureAttachments() enables delivery and registerAttachmentRoutes() is mounted.',
        ),
      )
    } else if (definitions || routesEntryMissing) {
      for (const relPath of scan.deliveryConfigs) {
        results.push(
          check(
            `attachments-delivery:${relPath}`,
            'Attachments delivery route',
            'fail',
            `configureAttachments() in ${relPath} enables delivery, but ` +
              (routesEntryMissing
                ? `the routes entry ${routesFile} does not exist, so nothing can mount the route. `
                : `no route registered by registerAttachmentRoutes() was found in the loaded route definitions. `) +
              `Private attachment URLs would be minted that 404 — and every delivery failure is a uniform ` +
              `404 by design, so nothing at runtime names this cause.`,
            `Call registerAttachmentRoutes(router) from the route registrar your app mounts ` +
              `(${routesFile}), or remove the delivery option.`,
            relPath,
          ),
        )
      }
    }

    if (definitions) {
      for (const routeName of scan.routeNames) {
        const claims = definitions.filter((definition) => definition.name === routeName)
        if (claims.length > 1) {
          results.push(
            check(
              `attachments-route-name:${routeName}`,
              'Attachments route name',
              'warn',
              `${claims.length} routes register the name '${routeName}'. Router.name() silently ` +
                `overwrites duplicates, so route() lookups and typed links resolve to whichever ` +
                `registered last.`,
              `Rename the app route, or set delivery.routeName to a name the app does not use.`,
            ),
          )
        }
      }
    }
  }

  if (scan.redirectDisks.length > 0) {
    const declarations = await scanStorageDisks(cache, files)
    for (const { relPath, disk } of scan.redirectDisks) {
      const driver = declarations.get(disk)?.driver
      // Unreadable (absent or conflicting evidence): skip, never guess.
      if (driver == null) continue
      const key = `attachments-serve-redirect:${relPath}:${disk}`
      const title = 'Attachments redirect disk'
      if (KNOWN_NON_PRESIGNING_DRIVERS.has(driver)) {
        results.push(
          check(
            key,
            title,
            'fail',
            `Disk '${disk}' is configured serve: 'redirect' in ${relPath}, but its storage driver ` +
              `'${driver}' cannot presign. At serve time the route fails closed into proxying with a ` +
              `warning, so the redirect you configured never happens.`,
            `Use serve: 'proxy' (or the default 'auto') for '${disk}', or move it to a driver that ` +
              `declares presignedGet (S3, or R2 with presign credentials).`,
            relPath,
          ),
        )
      } else if (KNOWN_PRESIGNING_DRIVERS.has(driver)) {
        results.push(
          check(key, title, 'pass', `Disk '${disk}' pairs serve: 'redirect' with driver '${driver}'.`),
        )
      }
      // Any other driver name: a capability this scan cannot read — skipped.
    }
  }

  return results
}
