import { readdir, readlink, realpath } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import type { CallExpression, ConditionalExpression, ObjectExpression, ObjectProperty } from '@babel/types'
import type { AppManifest, AttachmentsEntry, RouteDefinition } from '@guren/server'
import { literalString, memberKeyName, objectLiteral, unwrapTypeAssertion, walk, type BabelNode } from './ast-walk'
import { advisory, check, type CheckResult } from './check-result'
import { attributeManifestTable, resolveSchemaTableBinding, specifierBase, withoutExtension, type SchemaTableBinding } from './schema-binding'
import { discoverAppConfigFiles, fileExists } from './discovery'
import { loadRouteDefinitions } from './load-routes'
import { introspectedSection, judgedFromManifest, judgedFromSource, mergeVerdicts, readManifestSection, sole, type IntrospectedSection, type IntrospectSource } from './manifest-section'
import { routesEntryOrDefault } from './route-registrar'
import { parseModelSource } from './model-parser'
import type { ParseCache, ParsedFile } from './parse-cache'
import { schemaPathFor, type SchemaTable } from './schema-parser'

/**
 * The route `registerAttachmentRoutes()` mounts, by the name and controller class it
 * registers. Literals rather than imports, since the CLI does not depend on `@guren/core`;
 * `scripts/workspace-boundaries.test.ts` pins both to the runtime's values.
 */
export const DEFAULT_DELIVERY_ROUTE_NAME = 'attachments.show'
export const ATTACHMENT_DELIVERY_CONTROLLER_NAME = 'AttachmentDeliveryController'

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
 * Where a call may run later or not at all, so its absence from the introspected app proves nothing: a
 * function body, a class field initialiser or decorator, and any branch, loop or `try` at module scope.
 */
const GUARDING_NODES = new Set([
  'ClassProperty', 'ClassPrivateProperty', 'ClassAccessorProperty', 'Decorator',
  'IfStatement', 'ConditionalExpression', 'LogicalExpression', 'SwitchStatement', 'TryStatement',
  'ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement',
])

/**
 * The `configureAttachments()` calls a file makes under its `@guren/core` bindings (the named
 * import, aliases included, or `core.configureAttachments()` on a namespace import), and how many
 * of them are guarded ({@link GUARDING_NODES}). A comment or string merely containing the name does not count.
 */
async function configureAttachmentsCalls(cache: ParseCache, filePath: string): Promise<{ total: number; guarded: number }> {
  const none = { total: 0, guarded: 0 }
  const source = await cache.source(filePath)
  if (!source || !source.includes('configureAttachments')) return none

  const parsed = await cache.get(filePath)
  if (!parsed) return none

  const { configureLocal, coreNamespaces } = scanAttachmentsImports(parsed)
  if (!configureLocal && coreNamespaces.length === 0) return none

  const isCall = (node: BabelNode): boolean => {
    if (node.type !== 'CallExpression') return false
    const callee = (node as unknown as CallExpression).callee
    if (callee.type === 'Identifier') return callee.name === configureLocal
    return (
      callee.type === 'MemberExpression' &&
      !callee.computed &&
      callee.object.type === 'Identifier' &&
      coreNamespaces.includes(callee.object.name) &&
      callee.property.type === 'Identifier' &&
      callee.property.name === 'configureAttachments'
    )
  }
  let unconditional = 0
  let guarded = 0
  walk(parsed.ast, (node) => {
    // Every Babel function node carries `params` (the converse does not hold, which only errs towards guarded).
    if (Array.isArray(node.params) || GUARDING_NODES.has(node.type)) {
      walk(node, (inner) => {
        if (isCall(inner)) guarded++
      })
      return false
    }
    if (isCall(node)) unconditional++
  })
  return { total: unconditional + guarded, guarded }
}

async function fileCallsConfigureAttachments(cache: ParseCache, filePath: string): Promise<boolean> {
  return (await configureAttachmentsCalls(cache, filePath)).total > 0
}

/**
 * Whether the app (or one of its modules) wires the attachments layer: a
 * `configureAttachments` imported from `@guren/core` that is actually called.
 * For scaffolders (`make:feature --attach`) that would otherwise emit models whose
 * `Attachable` statics all throw at first use. Positive evidence only: a file that
 * cannot be read or parsed contributes nothing, so an opaque app is refused, not scaffolded broken.
 */
export async function appConfiguresAttachments(appRoot: string, cache: ParseCache): Promise<boolean> {
  for (const filePath of await discoverAppConfigFiles(appRoot)) {
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
  /** Candidate config files, from {@link discoverAppConfigFiles}. */
  configFiles: string[]
  /** The run's introspection, asked for only once an `Attachable(...)` model is found (RFC 0026 §5). */
  introspect?: IntrospectSource
  wiring?: Promise<AttachmentsWiring>
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

  const judge = (configured: boolean, neverRan?: string[]): CheckResult[] => attachableModels.map(({ className, relPath }) => {
    const key = `attachments-model:${relPath}`
    const title = 'Attachable model wiring'
    if (neverRan) {
      return check(
        key,
        title,
        'fail',
        `${className} in ${relPath} mixes in Attachable(...), and ${neverRan.join(', ')} calls configureAttachments(), `
          + 'but the introspected app never loads that module while it registers, so the call never runs and the first '
          + 'attach fails at runtime.',
        'Import the config from a provider the app registers (`bunx guren add attachments` writes AttachmentsProvider), '
          + 'so configureAttachments() runs at boot.',
        relPath,
      )
    }
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

  const wiring = await (options.wiring ?? readAttachmentsWiring(cwd, cache, configFiles, options.introspect))
  if (wiring.neverRan) return judgedFromManifest(judge(false, wiring.sites))
  if (wiring.sites.length > 0) {
    return wiring.engine.status === 'described' ? judgedFromManifest(judge(true)) : judgedFromSource(judge(true), wiring.engine.reason)
  }
  // No call in source: only the app can show an engine a helper configured.
  const section = await introspectedSection(options.introspect, 'attachments')
  if (section.status === 'static') return judgedFromSource(judge(false), section.reason)
  return judgedFromManifest(judge(section.value?.configured === true))
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
  /** The run's introspection, asked for only once a `configureAttachments()` call is found (RFC 0026 §5). */
  introspect?: IntrospectSource
  wiring?: Promise<AttachmentsWiring>
}): Promise<CheckResult[]> {
  const { cwd, cache, files, schemaTables } = options
  const calls = await scanAttachmentsTables(cwd, cache, files, schemaTables)
  const bindings = calls.flatMap((call) => (call.binding ? [{ ...call.binding, relPath: call.relPath }] : []))
  const results = bindings.map((binding) => {
    const key = `attachments-config:${binding.relPath}`
    const title = 'configureAttachments table'
    if (binding.declared) {
      return check(key, title, 'pass', `configureAttachments() binds schema table '${binding.tableName}'.`)
    }
    return check(
      key,
      title,
      'fail',
      `configureAttachments() in ${binding.relPath} binds '${binding.tableName}' from ${binding.source}, but no schema `
        + `module declares a table with that export. The layer takes the table untyped, so this only `
        + `fails at runtime, on the first attach.`,
      `Export '${binding.tableName}' from ${schemaPathFor(binding.schemaModule)} (the attachments guide has the snippet `
        + `per dialect), or point configureAttachments() at the table your schema does export.`,
      binding.relPath,
    )
  })

  const { sites, engine } = await (options.wiring ?? readAttachmentsWiring(cwd, cache, files, options.introspect))
  if (engine.status === 'static') return judgedFromSource(results, engine.reason)

  // One candidate per call, plus a file whose calls the scan cannot read (the namespace form).
  const unread: AttachmentsTableCall[] = sites.filter((relPath) => !calls.some((call) => call.relPath === relPath)).map((relPath) => ({ relPath }))
  const candidates = [...calls, ...unread]
  const { table } = engine.value
  const attributed = attributeManifestTable(table, candidates, schemaTables)
  if (!attributed) return judgedFromSource(results)
  const targets = attributed.at.length > 0 ? [...new Set(attributed.at.map((candidate) => candidate.relPath))] : [undefined]
  const verdicts = targets.map((relPath) => manifestTableVerdict(attributed.outcome, relPath, table))
  return mergeVerdicts(judgedFromManifest(verdicts), judgedFromSource(results))
}

/** Keyed on the config file, or on the rule alone when no call the source reads is the engine's. */
function manifestTableVerdict(outcome: 'untyped' | 'declared' | 'unfound', relPath: string | undefined, table: string | undefined): CheckResult {
  const key = relPath ? `attachments-config:${relPath}` : 'attachments-config'
  const title = 'configureAttachments table'
  const fix = 'Export the attachments table from db/schema.ts (the attachments guide has the snippet per dialect), and pass '
    + 'that export to configureAttachments().'
  switch (outcome) {
    case 'declared':
      return check(key, title, 'pass', `configureAttachments() binds schema table '${table}'.`)
    case 'untyped':
      return check(
        key,
        title,
        'fail',
        `The introspected attachments engine's \`table\` is not a Drizzle table. The layer takes the table untyped, so `
          + 'this only fails at runtime, on the first attach.',
        fix,
        relPath,
      )
    case 'unfound':
      return advisory(
        key,
        title,
        'warn',
        `The introspected attachments engine writes to table '${table}', which the schema reader did not find in any app `
          + "root's db/schema.ts. If no schema file drizzle-kit reads declares it, no migration creates it and the first attach fails.",
        `${fix} Ignore this if your drizzle.config reads it from another file.`,
        relPath,
      )
  }
}

/** One named-import `configureAttachments()` call, with what its `table` binds when that is a named `db/schema` import. */
interface AttachmentsTableCall {
  relPath: string
  binding?: SchemaTableBinding
}

/**
 * Every named-import `configureAttachments()` call (RFC 0013 Part 3). A `table` that is not a plain
 * identifier, or is imported from outside a `db/schema` module, has no binding. A schema renaming on
 * export (`export { a as attachments }`) reads as missing.
 */
async function scanAttachmentsTables(
  cwd: string,
  cache: ParseCache,
  files: string[],
  schemaTables: SchemaTable[],
): Promise<AttachmentsTableCall[]> {
  const calls: AttachmentsTableCall[] = []

  for (const filePath of files) {
    const source = await cache.source(filePath)
    if (!source || !source.includes('configureAttachments')) continue

    const parsed = await cache.get(filePath)
    if (!parsed) continue

    // Namespace-style configs (`core.configureAttachments(...)`) stay out of
    // this check's sight; the presence checks above do see them.
    const { configureLocal } = scanAttachmentsImports(parsed)
    if (!configureLocal) continue

    const relPath = relative(cwd, filePath)
    walk(parsed.ast, (node) => {
      if (node.type !== 'CallExpression') return
      const call = node as unknown as CallExpression
      if (call.callee.type !== 'Identifier' || call.callee.name !== configureLocal) return

      const argument = objectLiteral(call.arguments[0])
      const table = argument ? propertyNamed(argument, 'table')?.value : undefined
      // Judged against the schema module the import resolves to, so a module config
      // importing its own schema does not pass because the root declares the name.
      const binding = table?.type === 'Identifier'
        ? resolveSchemaTableBinding({ cwd, filePath, body: parsed.ast.program.body, identifier: table.name, schemaTables })
        : undefined
      calls.push(binding ? { relPath, binding } : { relPath })
    })
  }

  return calls
}

/** Why a rule that found a `configureAttachments()` inside a function was judged from source rather than the manifest. */
const NOT_REGISTERED_REASON = 'the introspected app ran no configureAttachments() while it registered, which a call in a provider\'s boot() would explain'

/** The files calling `configureAttachments()`, and the engine the introspected app configured. */
export interface AttachmentsWiring {
  sites: string[]
  engine: IntrospectedSection<AttachmentsEntry>
  /**
   * Set when the introspected app configured no engine although every call runs whenever its file loads,
   * no source imports a site dynamically and no `createApp({ boot })` was skipped: nothing the app
   * loads while registering imports those files. A `boot()` reaching one some other way still reads so.
   */
  neverRan?: true
}

/**
 * Reads the `configureAttachments()` calls and, once one is found (the content that starts the
 * introspection), the engine. `guren check` calls it once, before its suites, and hands it to
 * every attachments rule.
 */
export async function readAttachmentsWiring(
  cwd: string,
  cache: ParseCache,
  files: string[],
  introspect: IntrospectSource | undefined,
): Promise<AttachmentsWiring> {
  const calls = await Promise.all(files.map(async (filePath) => ({ relPath: relative(cwd, filePath), ...(await configureAttachmentsCalls(cache, filePath)) })))
  const sites = calls.filter((call) => call.total > 0).map((call) => call.relPath)
  if (sites.length === 0) return { sites, engine: { status: 'static' } }
  const section = await introspectedSection(introspect, 'attachments')
  if (section.status === 'static') return { sites, engine: section }
  if (section.value?.configured) return { sites, engine: { status: 'described', value: section.value, manifest: section.manifest } }
  const later = calls.some((call) => call.guarded > 0)
    || section.manifest.warnings.some((warning) => warning.code === 'boot-callback-skipped')
    || (await importsDynamically(cwd, cache, files, sites))
  if (later) return { sites, engine: { status: 'static', reason: NOT_REGISTERED_REASON } }
  const neverRanReason = `the introspected app never loaded ${sites.join(', ')} while it registered, so its configureAttachments() never ran`
  return { sites, engine: { status: 'static', reason: neverRanReason }, neverRan: true }
}

/** Whether a file imports one of `sites` through `import()`, or through one whose specifier it cannot read. */
async function importsDynamically(cwd: string, cache: ParseCache, files: string[], sites: string[]): Promise<boolean> {
  const targets = new Set(sites.map((site) => withoutExtension(resolve(cwd, site))))
  for (const filePath of files) {
    if (!(await cache.source(filePath))?.includes('import(')) continue
    const parsed = await cache.get(filePath)
    if (!parsed) continue
    let found = false
    walk(parsed.ast, (node) => {
      if (found) return false
      const dynamic = node.type === 'ImportExpression' || (node.type === 'CallExpression' && (node.callee as BabelNode).type === 'Import')
      if (!dynamic) return
      const specifier = literalString((node.source ?? (node.arguments as unknown[])[0]) as never)
      const base = specifier === null ? null : specifierBase(cwd, filePath, specifier)
      found = specifier === null || (base !== null && targets.has(withoutExtension(base)))
    })
    if (found) return true
  }
  return false
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
  /**
   * `root: './public/storage'`, the local driver's base directory. Several when
   * the value is a conditional of literals (`NODE_ENV === 'test' ? … : …`), and
   * the disk is then judged by every one of them.
   */
  roots?: readonly string[] | null
}

/** A string literal, or a conditional whose every branch is one. */
function literalStringBranches(value: unknown): string[] | null {
  const node = value && typeof value === 'object' ? unwrapTypeAssertion(value as ConditionalExpression) : null
  if (node?.type === 'ConditionalExpression') {
    const consequent = literalStringBranches(node.consequent)
    const alternate = literalStringBranches(node.alternate)
    return consequent && alternate ? [...new Set([...consequent, ...alternate])] : null
  }
  const single = literalString(value)
  return single === null ? null : [single]
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
  const record = <F extends keyof StorageDiskDeclaration>(
    disk: string,
    field: F,
    value: NonNullable<StorageDiskDeclaration[F]>,
  ) => {
    const existing = disks.get(disk) ?? {}
    // A disagreeing second declaration makes the field unreadable, and stays
    // that way: a sticky `null` is never equal to a later value either.
    if (existing[field] === undefined) existing[field] = value
    else if (JSON.stringify(existing[field]) !== JSON.stringify(value)) existing[field] = null
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
        const roots = literalStringBranches(propertyNamed(config, 'root')?.value)
        if (roots && roots.every(Boolean)) record(disk, 'roots', roots)
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
  /** Candidate config files, from {@link discoverAppConfigFiles}. */
  files: string[]
  /** The run's introspection, for the disk the engine writes to (RFC 0026 §5). */
  introspect?: IntrospectSource
  wiring?: Promise<AttachmentsWiring>
}): Promise<CheckResult[]> {
  const { cwd, cache, files } = options
  const scanned = await scanAttachmentsDefaultDisks(cwd, cache, files)
  const { sites, engine } = await (options.wiring ?? readAttachmentsWiring(cwd, cache, files, options.introspect))
  // The engine's disk joins the literals, which `disk: env.X` does not have.
  const defaults = engine.status === 'described' && engine.value.disk !== undefined
    ? withEngineDisk(scanned, engine.value.disk, sole(sites))
    : scanned
  if (defaults.length === 0) return []

  const declarations = await scanStorageDisks(cache, files)
  const drivers = engine.status === 'described' ? manifestDiskDrivers(engine.manifest) : new Map<string, string>()
  // The framework's own default: `publicPath` is `../public` relative to the
  // server module.
  const publicDir = resolve(cwd, 'public')
  const results: CheckResult[] = []

  for (const { relPath, disk } of defaults) {
    const declaration = declarations.get(disk)
    // Unreadable in either field: skip, never guess.
    if (!declaration || declaration.roots == null) continue
    if (!KNOWN_FILESYSTEM_DRIVERS.has(drivers.get(disk) ?? declaration.driver ?? '')) continue

    const key = relPath ? `attachments-public-disk:${relPath}:${disk}` : `attachments-public-disk:${disk}`
    const title = 'Attachments disk outside public/'
    let exposedRoot: string | undefined
    for (const root of declaration.roots) {
      if (await isReachableFromPublicDir(publicDir, resolve(cwd, root))) {
        exposedRoot = root
        break
      }
    }

    if (exposedRoot !== undefined) {
      results.push(
        check(
          key,
          title,
          'fail',
          `configureAttachments()${relPath ? ` in ${relPath}` : ''} stores new attachments on disk '${disk}', which is ` +
            `rooted at ${exposedRoot} — reachable through the public directory the app serves ` +
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
        check(key, title, 'pass', `Attachments disk '${disk}' is rooted outside public/ (${declaration.roots.join(', ')}).`),
      )
    }
  }

  // The root is read from source whichever way the disk was found, so the verdict is as strong as that.
  return judgedFromSource(results, engine.status === 'static' ? engine.reason : undefined)
}

/** The scanned default disks plus the engine's, attributed to the config naming it literally, else to the one config there is, else to none. */
function withEngineDisk(
  scanned: Array<{ relPath: string; disk: string }>,
  disk: string,
  only: string | undefined,
): Array<{ relPath?: string; disk: string }> {
  const relPath = scanned.find((entry) => entry.disk === disk)?.relPath ?? only
  return [{ relPath, disk }, ...scanned.filter((entry) => entry.relPath !== relPath || entry.disk !== disk)]
}

/** Each storage disk's driver as the introspected storage manager registered it; a factory-registered disk has none. */
function manifestDiskDrivers(manifest: AppManifest): Map<string, string> {
  const storage = readManifestSection(manifest, 'storage')
  const drivers = new Map<string, string>()
  if (storage.status !== 'described' || !storage.value) return drivers
  for (const [disk, { driver }] of Object.entries(storage.value.entries)) {
    if (driver !== null) drivers.set(disk, driver)
  }
  return drivers
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
  /** Candidate config files, from {@link discoverAppConfigFiles}. */
  files: string[]
  /** Routes entry file, POSIX-relative to `cwd`. */
  routesFile?: string
  /** Test seam, like the route-contract check's: definitions to use instead of loading. */
  definitions?: RouteDefinition[]
  /** The run's introspection, asked for only once a `configureAttachments()` call is found. */
  introspect?: IntrospectSource
  wiring?: Promise<AttachmentsWiring>
}): Promise<CheckResult[]> {
  const { cwd, cache, files } = options
  const scan = await scanAttachmentsDelivery(cwd, cache, files)
  const { sites, engine } = await (options.wiring ?? readAttachmentsWiring(cwd, cache, files, options.introspect))
  let disks: Promise<Map<string, StorageDiskDeclaration>> | undefined
  const declarations = () => (disks ??= scanStorageDisks(cache, files))
  if (engine.status === 'described') {
    // Mounting is app-wide, so only another config's redirect disks keep their source verdict.
    const manifest = await judgeManifestDelivery(engine.value, engine.manifest, scan, sole(sites), declarations)
    return mergeVerdicts(manifest, judgedFromSource(await staticRedirectVerdicts(scan, declarations)))
  }

  const results: CheckResult[] = []

  if (scan.deliveryConfigs.length > 0) {
    // The app's own entry, not routes/web.ts: an API-only app mounts the
    // delivery route in routes/api.ts.
    const routesFile = await routesEntryOrDefault(cwd, options.routesFile)
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
        (definition) => definition.controller?.name === ATTACHMENT_DELIVERY_CONTROLLER_NAME,
      ) ?? false

    if (mounted) {
      results.push(deliveryMounted())
    } else if (definitions || routesEntryMissing) {
      for (const relPath of scan.deliveryConfigs) {
        results.push(
          deliveryUnmounted(
            relPath,
            routesEntryMissing
              ? `the routes entry ${routesFile} does not exist, so nothing can mount the route. `
              : `no route registered by registerAttachmentRoutes() was found in the loaded route definitions. `,
            routesFile,
          ),
        )
      }
    }

    if (definitions) {
      for (const routeName of scan.routeNames) {
        const duplicate = duplicateRouteName(routeName, definitions)
        if (duplicate) results.push(duplicate)
      }
    }
  }

  results.push(...(await staticRedirectVerdicts(scan, declarations)))
  return judgedFromSource(results, engine.reason)
}

async function staticRedirectVerdicts(
  scan: AttachmentsDeliveryScan,
  declarations: () => Promise<Map<string, StorageDiskDeclaration>>,
): Promise<CheckResult[]> {
  if (scan.redirectDisks.length === 0) return []
  const declared = await declarations()
  // Unreadable (absent or conflicting evidence): skip, never guess.
  return scan.redirectDisks.flatMap(({ relPath, disk }) => judgeRedirectDisk(relPath, disk, declared.get(disk)?.driver) ?? [])
}

/**
 * The delivery rules over the engine the app configured. `delivery.mounted` is a route-name
 * lookup, so it counts only when that route is the delivery controller's. The disks to
 * redirect come from the engine, their driver from the storage manager, then from source.
 */
async function judgeManifestDelivery(
  engine: AttachmentsEntry,
  manifest: AppManifest,
  scan: AttachmentsDeliveryScan,
  /** The one file calling configureAttachments(), which a fact no literal names is attributed to; else keys name no file. */
  only: string | undefined,
  declarations: () => Promise<Map<string, StorageDiskDeclaration>>,
): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  const delivery = engine.delivery
  if (delivery) {
    const mounted = delivery.mounted && manifest.routes.some(
      (route) => route.name === delivery.routeName && route.controller?.name === ATTACHMENT_DELIVERY_CONTROLLER_NAME,
    )
    // The mount is app-wide, so an unmounted route is reported for every config enabling delivery, as the scan does.
    const relPaths = scan.deliveryConfigs.length > 0 ? scan.deliveryConfigs : [only]
    if (mounted) {
      results.push(deliveryMounted())
    } else {
      for (const relPath of relPaths) {
        results.push(deliveryUnmounted(relPath, `the introspected app registers no registerAttachmentRoutes() route named '${delivery.routeName}'. `))
      }
    }
    const duplicate = duplicateRouteName(delivery.routeName, manifest.routes)
    if (duplicate) results.push(duplicate)
  }

  const redirected = Object.entries(engine.disks ?? {}).filter(([, disk]) => disk.serve === 'redirect')
  if (redirected.length > 0) {
    const drivers = manifestDiskDrivers(manifest)
    for (const [disk] of redirected) {
      const relPath = scan.redirectDisks.find((entry) => entry.disk === disk)?.relPath ?? only
      const driver = drivers.get(disk)
      const verdict = judgeRedirectDisk(relPath, disk, driver ?? (await declarations()).get(disk)?.driver)
      if (verdict) results.push(driver === undefined ? judgedFromSource([verdict])[0]! : verdict)
    }
  }

  return judgedFromManifest(results)
}

function deliveryMounted(): CheckResult {
  return check(
    'attachments-delivery',
    'Attachments delivery route',
    'pass',
    'configureAttachments() enables delivery and registerAttachmentRoutes() is mounted.',
  )
}

/** Keyed on the config enabling delivery, or on the rule alone when no call the source reads sets it. */
function deliveryUnmounted(relPath: string | undefined, cause: string, routesFile?: string): CheckResult {
  return check(
    relPath ? `attachments-delivery:${relPath}` : 'attachments-delivery',
    'Attachments delivery route',
    'fail',
    `configureAttachments()${relPath ? ` in ${relPath}` : ''} enables delivery, but ${cause}` +
      `Private attachment URLs would be minted that 404 — and every delivery failure is a uniform ` +
      `404 by design, so nothing at runtime names this cause.`,
    `Call registerAttachmentRoutes(router) from the route registrar your app mounts${routesFile ? ` (${routesFile})` : ''}, or remove the delivery option.`,
    relPath,
  )
}

function duplicateRouteName(routeName: string, routes: ReadonlyArray<{ name?: string }>): CheckResult | undefined {
  const claims = routes.filter((route) => route.name === routeName).length
  if (claims <= 1) return undefined
  return check(
    `attachments-route-name:${routeName}`,
    'Attachments route name',
    'warn',
    `${claims} routes register the name '${routeName}'. Router.name() silently ` +
      `overwrites duplicates, so route() lookups and typed links resolve to whichever ` +
      `registered last.`,
    `Rename the app route, or set delivery.routeName to a name the app does not use.`,
  )
}

/** A `serve: 'redirect'` disk against its driver; `undefined` for a driver this check cannot vouch for either way. */
function judgeRedirectDisk(relPath: string | undefined, disk: string, driver: string | null | undefined): CheckResult | undefined {
  if (driver == null) return undefined
  const key = relPath ? `attachments-serve-redirect:${relPath}:${disk}` : `attachments-serve-redirect:${disk}`
  const title = 'Attachments redirect disk'
  if (KNOWN_NON_PRESIGNING_DRIVERS.has(driver)) {
    return check(
      key,
      title,
      'fail',
      `Disk '${disk}' is configured serve: 'redirect'${relPath ? ` in ${relPath}` : ''}, but its storage driver ` +
        `'${driver}' cannot presign. At serve time the route fails closed into proxying with a ` +
        `warning, so the redirect you configured never happens.`,
      `Use serve: 'proxy' (or the default 'auto') for '${disk}', or move it to a driver that ` +
        `declares presignedGet (S3, or R2 with presign credentials).`,
      relPath,
    )
  }
  if (KNOWN_PRESIGNING_DRIVERS.has(driver)) {
    return check(key, title, 'pass', `Disk '${disk}' pairs serve: 'redirect' with driver '${driver}'.`)
  }
  // Any other driver name: a capability this scan cannot read.
  return undefined
}
