import { readdir, readlink, realpath } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import type { CallExpression, ObjectExpression, ObjectProperty } from '@babel/types'
import { AttachmentDeliveryController, DEFAULT_DELIVERY_ROUTE_NAME, type RouteDefinition } from '@guren/core'
import { literalString, memberKeyName, objectLiteral, unwrapTypeAssertion, walk } from './ast-walk'
import { check, type CheckResult } from './check-result'
import { collectFiles, fileExists, listAppRoots } from './discovery'
import { DEFAULT_ROUTES_FILE, loadRouteDefinitions } from './load-routes'
import { resolveRoutesEntry } from './route-registrar'
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
 * Which schema a `db/schema` import lands on: the root schema (null) or a
 * module's. The existence question is per schema module — a module config
 * importing its *own* schema must not pass on the strength of a table the root
 * declares. Undefined for a specifier resolving outside both shapes.
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
   * The schema declares exported names, so `import { attachments as att }` must
   * be judged by 'attachments'. Default and namespace imports have no single
   * exported name; recorded with an empty `imported` so callers can skip them.
   */
  importsByLocal: Map<string, { source: string; imported: string }>
}

/**
 * One reading of a file's imports for every consumer in this file — the
 * scaffolder preflight, the `guren check` rules, and the table check. A second
 * copy is how `guren check` goes green while `make:feature --attach` refuses.
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
 * `core.configureAttachments()` member call on a namespace import. A comment or
 * string merely containing the name does not count.
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
 * For scaffolders (`make:feature --attach`) that would otherwise emit models whose
 * `Attachable` statics all throw at first use. Positive evidence only: a file that
 * cannot be read or parsed contributes nothing, so an opaque app is refused, not scaffolded broken.
 */
export async function appConfiguresAttachments(appRoot: string, cache: ParseCache): Promise<boolean> {
  for (const filePath of await discoverAttachmentsConfigFiles(appRoot)) {
    if (await fileCallsConfigureAttachments(cache, filePath)) return true
  }
  return false
}

/**
 * Flags models that mix in `Attachable(...)` in an app with no
 * `configureAttachments()` call anywhere (RFC 0013). The mixin's statics resolve
 * the configured layer lazily, so a model builds, typechecks and boots with no
 * attachments config at all and only fails on the first `attach()`.
 * Presence-only: which table the config binds is {@link checkAttachmentsConfig}.
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

  // Only files naming the mixin are worth parsing.
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
 * `db/schema.ts` declares (RFC 0013 Part 3). The layer takes the table as `unknown`,
 * so a renamed export only fails on the first attach. Positive evidence only: a
 * `table` that is not a plain identifier, or is imported from outside a `db/schema`
 * module, is skipped. A schema renaming on export (`export { a as attachments }`) reads as missing.
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
    const source = await cache.source(filePath)
    if (!source || !source.includes('configureAttachments')) continue

    const parsed = await cache.get(filePath)
    if (!parsed) continue

    // Namespace-style configs (`core.configureAttachments(...)`) stay out of
    // this check's sight; the presence checks above do see them.
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
 * `core.configureAttachments()` namespace form alike.
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
 * What a `disks` map declares about one disk. `null` means "this scan cannot
 * say": absent, not a string literal, or declared two different ways. Read
 * per-field so conflicting evidence about one property never withdraws a rule
 * that reads the other.
 */
interface StorageDiskDeclaration {
  /** `driver: 'local' | 's3' | …` */
  driver?: string | null
  /** `root: './public/storage'` — the local driver's base directory. */
  root?: string | null
}

/**
 * The storage disks the app's config declares, per disk name. A field counts when
 * a `disks` property carries an object literal (inline, or through a same-file
 * `const`) with a string-literal value; two sources disagreeing makes it unreadable
 * (`null`). The candidate set must keep sweeping all of config/, src/, and app/:
 * narrowing it blinds the redirect rule (a runCheck test pins this), since nothing proves a map reaches `createStorageManager()`.
 */
async function scanStorageDisks(cache: ParseCache, files: string[]): Promise<Map<string, StorageDiskDeclaration>> {
  const disks = new Map<string, StorageDiskDeclaration>()
  const record = (disk: string, field: keyof StorageDiskDeclaration, value: string) => {
    const existing = disks.get(disk) ?? {}
    // A disagreeing second declaration makes the field unreadable, and stays
    // that way: a sticky `null` is never equal to a later value either.
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
 * Is the disk rooted at `root` reachable through the served `publicDir`? Three
 * tests, none subsuming the others: lexical (a root that does not exist yet cannot
 * be canonicalized), canonical on *both* sides (a project reached through a symlink
 * is routine), and the served tree's own entries (a link pointing out at the root, which
 * `guren storage:link` creates). Only the immediate entries of `publicDir` are read.
 */
async function isReachableFromPublicDir(publicDir: string, root: string): Promise<boolean> {
  if (isAtOrWithin(publicDir, root)) return true

  const [realPublic, realRoot] = await Promise.all([canonicalize(publicDir), canonicalize(root)])
  if (isAtOrWithin(realPublic, realRoot)) return true

  // ENOENT read directly rather than probed for: an existsSync-style pre-check
  // turns a permissions error on the parent into "absent", failing this open.
  const entries = await readdir(publicDir, { withFileTypes: true }).catch(() => null)
  if (!entries) return false

  const links = entries.filter((entry) => entry.isSymbolicLink())
  const targets = await Promise.all(links.map((entry) => linkTarget(join(publicDir, entry.name))))

  // Judged against `<root>/attachments` (the engine's object key prefix), not
  // the disk root: `storage:link` exposes `storage/app/public`, inside the
  // scaffold's own root, so a mere overlap test would fail the default scaffold.
  // Both directions, since a link may expose a directory containing the uploads
  // or one inside them (`public/leak -> storage/app/attachments/<id>`).
  const prefix = join(realRoot, 'attachments')
  return targets.some((target) => isAtOrWithin(target, prefix) || isAtOrWithin(prefix, target))
}

/**
 * `realpath` for a path that need not exist: the deepest existing ancestor is
 * resolved and the remaining segments appended unchanged. Falling back to the raw
 * input instead is a false pass — one side resolved and the other not are written in
 * different vocabularies and never match (on macOS `/var/folders/…` against
 * `/private/var/folders/…`), and both sides here routinely name directories not yet created.
 */
async function canonicalize(path: string): Promise<string> {
  let current = path
  const trailing: string[] = []

  // Bounded by the path's own depth: `dirname` reaches the root and stops.
  while (true) {
    const resolved = await realpath(current).catch(() => null)
    if (resolved !== null) return trailing.length === 0 ? resolved : join(resolved, ...trailing)
    const parent = dirname(current)
    if (parent === current) return path
    trailing.unshift(basename(current))
    current = parent
  }
}

/**
 * Where a symlink points, canonicalized — falling back to the link's own resolved
 * target when the destination does not exist yet. `realpath` alone fails open: a
 * link created before its target resolves to the link's own path under `public/`,
 * which matches nothing, and the first upload then creates the directory and
 * serves every attachment.
 */
async function linkTarget(path: string): Promise<string> {
  const target = await readlink(path).catch(() => null)
  if (target === null) return canonicalize(path)
  return canonicalize(resolve(dirname(path), target))
}

/**
 * The disk new attachments are written to, per config file — the required
 * `disk` option, naming one entry of the storage manager's map.
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
 * `configureAttachments({ disk })` pointing at a local disk rooted inside the
 * app's public directory: every upload is then fetchable by URL with no
 * signature, expiry or authorization check, and no delivery configuration
 * repairs it. Narrow on purpose (driver literally `local`, declared `root` at or
 * below `<cwd>/public`) since this rule fails a build.
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
  // The framework's own default: `publicPath` is `../public` relative to the
  // server module.
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

    if (await isReachableFromPublicDir(publicDir, root)) {
      results.push(
        check(
          key,
          title,
          'fail',
          `configureAttachments() in ${relPath} stores new attachments on disk '${disk}', which is ` +
            `rooted at ${declaration.root} — reachable through the public directory the app serves ` +
            `statically. Every upload is then fetchable by URL with no signature, no expiry and no ` +
            `authorization check, whatever the delivery route is configured to do, because nothing ` +
            `has to go through it to reach the file. Serving those bytes is only as safe as the ` +
            `static mount's own defences: they force a download for document types today, but ` +
            `rootPublicAssets: { inlineDocuments: true } opts back out and restores the stored-XSS ` +
            `case for an uploaded .svg or .html.`,
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
 * Twinned with `StorageDriverCapabilities.presignedGet` in @guren/server, which
 * `S3Driver` declares, `LocalDriver`/`MemoryDriver` never do, and `R2Driver`
 * declares only with `presign` credentials. A name in neither set is skipped,
 * never guessed in either direction.
 */
const KNOWN_NON_PRESIGNING_DRIVERS = new Set(['local', 'memory'])
const KNOWN_PRESIGNING_DRIVERS = new Set(['s3'])

/**
 * Drivers whose `root` is a filesystem path, so that "is this disk inside
 * public/?" is a question about it at all. Same never-guess policy as the
 * presigning sets above; no runtime twin, since `root` is meaningful only to
 * `LocalDriver`.
 */
const KNOWN_FILESYSTEM_DRIVERS = new Set(['local'])

/**
 * The RFC 0015 delivery-route wiring rules:
 * 1. `delivery` with no `registerAttachmentRoutes()` route in the *loaded*
 *    definitions (not the AST, which cannot follow helpers) — URLs 404 mutely.
 * 2. A delivery route name claimed twice — `Router.name()` silently overwrites.
 * 3. `serve: 'redirect'` on a driver that cannot presign — downgrades to proxy with a warning at serve time.
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
    // The app's own entry, not routes/web.ts: an API-only app mounts the
    // delivery route in routes/api.ts.
    const routesFile = options.routesFile ?? (await resolveRoutesEntry(cwd)) ?? DEFAULT_ROUTES_FILE
    let definitions = options.definitions
    let routesEntryMissing = false
    if (!definitions) {
      if (await fileExists(cwd, routesFile)) {
        try {
          definitions = await loadRouteDefinitions(resolve(cwd, routesFile), cwd)
        } catch {
          // An app whose routes cannot load is reported by the route checks;
          // `definitions` stays undefined and this rule stays quiet.
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
