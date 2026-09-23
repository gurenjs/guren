/**
 * What `plan:status` (RFC 0030 §6) compares a plan with, beyond the names the §2 checks
 * read: each reader's properties, and the evidence that something is mounted. Built by
 * `loadPlanAppState({ detail: true })` from the same scans, so the two commands cannot
 * disagree about what the application holds. Every section is a list or the reason it
 * could not be read; a reader that answers a lower bound says so beside its list.
 */

import { relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { RouteDefinition } from '@guren/server'
import type { File, Node, Statement } from '@babel/types'

import { unwrapTypeAssertion, propertyValue, topLevelDeclaration } from '../ast-walk'
import { createAppOptions, moduleMountState } from '../app-entry'
import { CONTRACT_SEGMENTS } from '../contract-segments'
import type { ContextRoute } from '../context-route'
import { accessorCallPattern, blankCommentsAndStrings, type ControllerMemberName, type ControllerMethodScan } from '../controller-methods'
import {
  classNameFromPath,
  discoverEventFiles,
  discoverJobFiles,
  discoverListenerFiles,
  discoverMailFiles,
  discoverModelFiles,
  discoverModuleRoutesFiles,
  discoverNotificationFiles,
  discoverPolicyFiles,
  discoverResourceFiles,
  discoverRoutesFiles,
  discoverValidatorFiles,
  excludeBarrelFiles,
  findFirstExisting,
  listModuleNames,
  moduleNameFor,
  moduleNameFromRelPath,
  moduleRoutesEntryCandidates,
  toPosixRelative,
} from '../discovery'
import { extractInertiaPageRefs, describeInertiaPagePropKeys, resolveInertiaPageFile } from '../inertia-pages'
import { discoverParsedModels, type ModelRelationship } from '../model-parser'
import type { PagePropKeys } from '../page-props-extractor'
import { ParseCache } from '../parse-cache'
import { resolveAppEntry } from '../provider-registrar'
import { REGISTRAR_EXPORT_NAMES, REGISTRAR_PATTERN, specifierName } from '../route-registrar'
import { importsByLocal, specifierBase, withoutExtension } from '../schema-binding'
import { readSchemaTables, withImportTimeout, type SourcedSchemaTable } from '../schema-runtime'
import { routePathCovers } from '../test-requests'
import type { PlanAppScope, PlanAppUnreadable } from './app-state'
import { readResourcePayloads, readSchemaFields, type PlanAppResourcePayload, type PlanAppSchemaFields } from './field-readers'
import { readPolicyAbilities, type PlanAppPolicyAbilities } from './policy-abilities'
import { scanSideEffectUses, type SideEffectUses } from './side-effect-uses'

/** `mounted`, or why this command could not confirm it. Absence of evidence is never `mounted`. */
export type PlanAppMount = 'mounted' | { unconfirmed: string }

export interface PlanAppRouteDetail {
  name?: string
  method: string
  path: string
  /** `ClassName.action`; absent for an inline or prototype handler. */
  action?: string
  middleware: string[]
  /** An inline middleware has no name, so a planned name missing from `middleware` is not visible rather than absent. */
  hasInlineMiddleware: boolean
  /** Route parameter → bound model class. */
  bindings: Record<string, string>
  agent?: { toolName?: string; readOnly?: boolean }
  /** Still answered by its prototype fixture (RFC 0021), so no controller action serves it. */
  prototype?: true
  /** The module whose registrar declared the route, or `null` for the entry registrar. */
  module: string | null
  /** The entry routes file, app-relative. A module's route is placed by its module's routes files. */
  file?: string
  /**
   * Exported validator symbols this registered route's contract schemas *are*, matched
   * by object identity rather than by name: the registrar ran, so a schema reached here
   * only from a call the application made.
   */
  contractSchemas: string[]
  /** Why a route registered before it may answer its requests; absent when none can. */
  shadowed?: Exclude<PlanAppMount, 'mounted'>
}

export interface PlanAppModelDetail {
  className: string
  module: PlanAppScope
  /** App-relative, POSIX separators, as every `file` here: what `plan:verify` fingerprints. */
  file: string
  /** The table identifier the class binds, when the parser could read it. */
  table?: string
  relationships: ModelRelationship[]
  fillable: string[] | 'unreadable' | null
}

export interface PlanAppActionDetail {
  /** `ClassName.action`. */
  key: string
  module: PlanAppScope
  /** The controller's file. */
  file: string
  /** Inertia page ids the body returns. */
  pages: string[]
  /** `this.<member>(` calls in the body, comments and strings excluded. */
  calls: string[]
  /** Abilities passed to `this.authorize()` / `this.can()` as a string literal. */
  abilities: string[]
  /** Identifiers the body mentions, comments and strings excluded: a mention, not a use. */
  identifiers: string[]
  /** Schemas handed to `this.validateBody/Query/Params(`, which is a use; a member chain as written (`schemas.post`). */
  validates: string[]
}

export interface PlanAppPageDetail {
  id: string
  /** Absent when the page has no component file. */
  file?: string
  props: PagePropKeys
}

export interface PlanAppValidatorDetail {
  /** The exported schema symbol, which is how a plan names a validator. */
  name: string
  file: string
  module: PlanAppScope
  /** Why the file would not import, which leaves the symbol unmatchable against a route contract. */
  unimported?: string
  /** The export's input fields, read off the imported object; unreadable for anything but an object schema. */
  fields: PlanAppSchemaFields
}

/** A class a plan names and a directory scan discovers, for the kinds with no other reader. */
export interface PlanAppClassDetail {
  className: string
  module: PlanAppScope
  file: string
}

/** A routes file and what it names, for the note on an element nothing wired. */
export interface PlanAppRouteFile {
  file: string
  /** Identifiers outside the import and re-export statements: a mention, not a use. */
  identifiers: string[]
}

/** A policy class and its abilities, or why they could not be read. */
export interface PlanAppPolicyDetail extends PlanAppClassDetail {
  abilities: PlanAppPolicyAbilities | PlanAppUnreadable
}

export type PlanAppSideEffectKind = 'job' | 'event' | 'listener' | 'mail' | 'notification'

/** A side-effect class and where the application's source uses it (`side-effect-uses.ts`). */
export interface PlanAppSideEffectDetail extends PlanAppClassDetail {
  /** App files that dispatch, register or send it: a use, which is what `wired` rests on. */
  usedIn: string[]
  /** App files that may use it in a way the scan cannot confirm: a listener in an `on()` handler whose event is no class. */
  unprovenIn: string[]
  /** App files naming it outside imports and types without a use, for the note on one nothing wires. */
  mentionedIn: string[]
}

export interface PlanAppDetail {
  routes: PlanAppRouteDetail[] | PlanAppUnreadable
  /** Set when a module's routes did not load, which leaves `routes` a lower bound. */
  routesIncomplete?: string
  mounts: { entry: PlanAppMount; modules: Record<string, PlanAppMount> }
  tables: SourcedSchemaTable[] | PlanAppUnreadable
  models: PlanAppModelDetail[] | PlanAppUnreadable
  /** Files under a models directory that yielded no model class, app-relative. */
  unparsedModelFiles: string[]
  actions: PlanAppActionDetail[] | PlanAppUnreadable
  controllers: PlanAppClassDetail[] | PlanAppUnreadable
  /** Controller class names two files declare: a route names a class, never a file. */
  controllerCollisions: string[]
  pages: PlanAppPageDetail[] | PlanAppUnreadable
  validators: PlanAppValidatorDetail[] | PlanAppUnreadable
  resources: PlanAppClassDetail[]
  /** What `guren codegen` reads each resource's payload as, for a planned resource's fields. */
  resourcePayloads: PlanAppResourcePayload[] | PlanAppUnreadable
  policies: PlanAppPolicyDetail[]
  routeFiles: PlanAppRouteFile[]
  sideEffects: Record<PlanAppSideEffectKind, PlanAppSideEffectDetail[]>
  /** Per kind, why an absent use proves nothing: a source file that did not parse, a scan that failed, `AutoDiscovery`. */
  sideEffectUsesUnread?: Partial<Record<PlanAppSideEffectKind, string>>
}

/** What `loadPlanAppState()` already holds when it asks for the detail. */
export interface PlanAppDetailInput {
  root: string
  /** The entry routes file that was loaded, app-relative; `undefined` when the app has none. */
  routesFile: string | undefined
  routes: ContextRoute[] | PlanAppUnreadable
  /** The definitions `routes` was rendered from, in the same order, for the live contract schemas. */
  definitions: RouteDefinition[] | undefined
  provenance: Array<string | null>
  moduleWarnings: string[]
  controllers: ControllerMethodScan | PlanAppUnreadable
  pages: string[] | PlanAppUnreadable
  models: PlanAppUnreadable | undefined
}

const IDENTIFIER_PATTERN = /[A-Za-z_$][\w$]*/g
const MEMBER_CALL_PATTERN = /\bthis\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g
const ABILITY_PATTERN = /\bthis\s*\.\s*(?:authorize|can)\s*\(\s*(['"`])([^'"`]+)\1/g

/** Spelled through `ControllerMemberName`, so a rename in `Controller.ts` fails to compile. */
const VALIDATE_MEMBERS = [
  'validateBody',
  'validateBodySafe',
  'validateQuery',
  'validateQuerySafe',
  'validateParams',
  'validateParamsSafe',
] as const satisfies readonly ControllerMemberName[]

const VALIDATE_CALL_PATTERN = new RegExp(
  `\\bthis\\s*\\.\\s*${accessorCallPattern(VALIDATE_MEMBERS)}\\s*([A-Za-z_$][\\w$]*(?:\\s*\\.\\s*[A-Za-z_$][\\w$]*)*)`,
  'g',
)

/** A validator file is imported like the schema, so it gets the schema reader's budget. */
const VALIDATOR_IMPORT_TIMEOUT_MS = 5000

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)]
}

export async function loadPlanAppDetail(input: PlanAppDetailInput): Promise<PlanAppDetail> {
  const { root } = input
  const cache = new ParseCache()

  const [tables, models, pages, validatorRead, resources, resourcePayloads, policies, routeFiles, sideEffects, mounts] = await Promise.all([
    tableDetail(root),
    modelDetail(root, input.models),
    pageDetail(root, input.pages),
    validatorDetail(root, cache, contractSchemaObjects(input.definitions)),
    classDetail(root, discoverResourceFiles),
    readResourcePayloads(root),
    policyDetail(root, cache),
    routeFileDetail(root, cache, input.routesFile),
    sideEffectDetail(root, cache),
    mountDetail(root, cache, input),
  ])

  return {
    routes: routeDetail(input, validatorRead.symbols),
    ...(input.moduleWarnings.length > 0 ? { routesIncomplete: input.moduleWarnings.join(' ') } : {}),
    mounts,
    tables,
    ...models,
    ...actionDetail(root, input.controllers),
    pages,
    validators: validatorRead.validators,
    resources,
    resourcePayloads,
    policies,
    routeFiles,
    ...sideEffects,
  }
}

/** The live contract schemas of every registered route, whatever a plan calls them. */
function contractSchemaObjects(definitions: RouteDefinition[] | undefined): Set<object> {
  const objects = new Set<object>()
  for (const definition of definitions ?? []) {
    for (const key of CONTRACT_SEGMENTS) {
      const schema = definition.schemas?.[key]
      if (schema !== null && typeof schema === 'object') objects.add(schema)
    }
  }
  return objects
}

function routeDetail(input: PlanAppDetailInput, symbols: SchemaSymbols): PlanAppDetail['routes'] {
  const routes = input.routes
  if (!Array.isArray(routes)) return routes
  return routes.map((route, index) => {
    const shadowed = shadowing(input, routes, index)
    return {
      name: route.name,
      method: route.method,
      path: route.path,
      ...(route.controller ? { action: `${route.controller.name}.${route.controller.action}` } : {}),
      middleware: route.middleware ?? [],
      hasInlineMiddleware: route.hasInlineMiddleware === true,
      bindings: route.bindings ?? {},
      ...(route.agent ? { agent: { toolName: route.agent.toolName, readOnly: route.agent.readOnlyHint } } : {}),
      ...(route.prototype ? { prototype: true as const } : {}),
      module: input.provenance[index] ?? null,
      ...(input.provenance[index] == null && input.routesFile !== undefined ? { file: input.routesFile } : {}),
      contractSchemas: contractSymbols(input.definitions?.[index], symbols),
      ...(shadowed ? { shadowed } : {}),
    }
  })
}

/**
 * Hono hands a request to the first registered route that matches it, in `mountRoutes()`'s
 * order: the entry registrar's routes, then each module's in `createApp({ modules })` order.
 * The CLI loads modules in directory order instead, so two modules' routes are compared both
 * ways and never settled. The routes a provider registers are not in the definitions.
 */
function shadowing(input: PlanAppDetailInput, routes: ContextRoute[], index: number): Exclude<PlanAppMount, 'mounted'> | undefined {
  const route = routes[index]!
  const scope = input.provenance[index] ?? null
  const routeMethod = route.method.toUpperCase()
  const self = `${routeMethod} ${route.path}`
  const site = (candidate: ContextRoute, otherScope: string | null): string =>
    `${candidate.method.toUpperCase()} ${candidate.path}${routeLabel(candidate)}, registered by ${otherScope === null ? (input.routesFile ?? 'the entry registrar') : `modules/${otherScope}`}`
  let uncertain: string | undefined
  // A later definite shadow outranks an earlier uncertain one, so the scan does not stop at the first.
  for (let other = 0; other < routes.length; other += 1) {
    const candidate = routes[other]!
    const otherScope = input.provenance[other] ?? null
    const sameScope = otherScope === scope
    const acrossModules = !sameScope && scope !== null && otherScope !== null
    const before = sameScope ? other < index : acrossModules || otherScope === null
    const method = candidate.method.toUpperCase()
    if (!before || (method !== routeMethod && method !== 'ALL')) continue
    const covers = routePathCovers(candidate.path, route.path)
    if (covers === 'none') continue
    if (covers === 'match' && !acrossModules) {
      return { unconfirmed: `${self} is shadowed and never reached: ${site(candidate, otherScope)}, comes first and answers every request its path matches` }
    }
    uncertain ??= acrossModules
      ? `${self} may be shadowed by ${site(candidate, otherScope)}: two modules register in createApp({ modules }) order, which this does not read`
      : `${self} may be shadowed by ${site(candidate, otherScope)}, which comes first: whether it answers every request this path matches could not be judged`
  }
  if (uncertain !== undefined) return { unconfirmed: uncertain }
  if (scope !== null && input.moduleWarnings.length > 0) {
    return { unconfirmed: `${self} may be shadowed: a module's routes did not load, and one registered before it may answer its requests (${input.moduleWarnings.join(' ')})` }
  }
  return undefined
}

function routeLabel(route: ContextRoute): string {
  const parts: string[] = []
  if (route.name) parts.push(`"${route.name}"`)
  if (route.controller) parts.push(`${route.controller.name}.${route.controller.action}`)
  return parts.length > 0 ? ` (${parts.join(', ')})` : ''
}

function contractSymbols(definition: RouteDefinition | undefined, symbols: SchemaSymbols): string[] {
  const schemas = definition?.schemas
  if (!schemas) return []
  return unique(
    CONTRACT_SEGMENTS.flatMap((key) => {
      const schema = schemas[key]
      return schema !== null && typeof schema === 'object' ? (symbols.get(schema) ?? []) : []
    }),
  )
}

/**
 * `readSchemaTables()` never throws and reports a schema that would not import per file,
 * its tables falling back to the static reading. No table from a schema that exists is
 * the one case left unreadable, as in the static section.
 */
async function tableDetail(root: string): Promise<PlanAppDetail['tables']> {
  try {
    const read = await readSchemaTables(root)
    const silent = read.files.find(
      (file) => file.status === 'unreadable' && !read.tables.some((table) => table.module === file.module),
    )
    if (silent?.status === 'unreadable') return { unreadable: silent.reason }
    return read.tables
  } catch (error) {
    return { unreadable: reasonOf(error) }
  }
}

async function modelDetail(
  root: string,
  unreadable: PlanAppUnreadable | undefined,
): Promise<Pick<PlanAppDetail, 'models' | 'unparsedModelFiles'>> {
  if (unreadable) return { models: unreadable, unparsedModelFiles: [] }
  try {
    const [models, files] = await Promise.all([discoverParsedModels(root), discoverModelFiles(root)])
    const parsed = new Set(models.map((model) => model.relPath))
    return {
      models: models.map(({ info, module, relPath }) => ({
        className: info.className,
        module,
        file: relPath,
        table: info.tableName,
        relationships: info.relationships,
        fillable: info.fillable,
      })),
      unparsedModelFiles: excludeBarrelFiles(files).map((file) => toPosixRelative(root, file)).filter((file) => !parsed.has(file)),
    }
  } catch (error) {
    return { models: { unreadable: reasonOf(error) }, unparsedModelFiles: [] }
  }
}

/** One reading of every action body, which `plan:status` and Impact both take. */
export function describeActions(root: string, controllers: ControllerMethodScan): PlanAppActionDetail[] {
  return [...controllers.methods].map(([key, info]): PlanAppActionDetail => {
    // A page id and an ability are string contents, which only the raw body holds; the
    // blanked body, offsets preserved, says whether a match there is code or a comment.
    const isCode = (index: number): boolean => info.body.startsWith('this', index)
    return {
      key,
      module: moduleNameFor(root, resolve(root, info.filePath)),
      file: toPosixRelative(root, resolve(root, info.filePath)),
      pages: extractInertiaPageRefs(info.rawBody, isCode).map((ref) => ref.id),
      calls: unique([...info.body.matchAll(MEMBER_CALL_PATTERN)].map((match) => match[1]!)),
      abilities: unique([...info.rawBody.matchAll(ABILITY_PATTERN)].filter((match) => isCode(match.index)).map((match) => match[2]!)),
      identifiers: unique(info.body.match(IDENTIFIER_PATTERN) ?? []),
      validates: unique([...info.body.matchAll(VALIDATE_CALL_PATTERN)].map((match) => match[1]!.replace(/\s+/g, ''))),
    }
  })
}

function actionDetail(
  root: string,
  controllers: ControllerMethodScan | PlanAppUnreadable,
): Pick<PlanAppDetail, 'actions' | 'controllers' | 'controllerCollisions'> {
  if (!('methods' in controllers)) return { actions: controllers, controllers, controllerCollisions: [] }
  return {
    actions: describeActions(root, controllers),
    controllers: [...controllers.classFiles].map(([className, relPath]) => ({
      className,
      module: moduleNameFor(root, resolve(root, relPath)),
      file: toPosixRelative(root, resolve(root, relPath)),
    })),
    controllerCollisions: unique(controllers.collisions.map((collision) => collision.className)),
  }
}

/** Classes a directory scan discovers, each tagged with the app root it came from. */
export async function classDetail(root: string, discover: (appRoot: string) => Promise<string[]>): Promise<PlanAppClassDetail[]> {
  const files = excludeBarrelFiles(await discover(root).catch((): string[] => []))
  return files.map((file) => ({ className: classNameFromPath(file), module: moduleNameFor(root, file), file: toPosixRelative(root, file) }))
}

async function pageDetail(root: string, pages: string[] | PlanAppUnreadable): Promise<PlanAppDetail['pages']> {
  if (!Array.isArray(pages)) return pages
  return Promise.all(
    pages.map(async (id) => {
      const file = await resolveInertiaPageFile(root, id)
      return {
        id,
        ...(file === undefined ? {} : { file }),
        props: (await describeInertiaPagePropKeys(root, id)) ?? { status: 'unreadable' as const, reason: 'the page has no component file' },
      }
    }),
  )
}

/**
 * Names a module exports, or `null` when an export form hides some. `'this file'` drops
 * a name re-exported from elsewhere: the symbol is declared in that other file, and the
 * app root it sits in is that file's, not this one's. The runtime export list holds both,
 * which is why {@link registrarExport} asks for `'anywhere'`.
 */
function exportedNames(ast: File, declaredIn: 'anywhere' | 'this file'): string[] | null {
  const names: string[] = []
  for (const node of ast.program.body) {
    if (node.type === 'ExportAllDeclaration') return null
    if (node.type === 'ExportDefaultDeclaration') names.push('default')
    if (node.type !== 'ExportNamedDeclaration') continue
    if (!(node.source && declaredIn === 'this file')) {
      for (const specifier of node.specifiers) {
        if (specifier.type === 'ExportSpecifier') names.push(specifierName(specifier.exported))
      }
    }
    const declaration = node.declaration
    if (declaration?.type === 'FunctionDeclaration' && declaration.id) names.push(declaration.id.name)
    const variables = topLevelDeclaration(node as Statement)
    for (const declarator of variables?.declarations ?? []) {
      if (declarator.id.type === 'Identifier') names.push(declarator.id.name)
    }
  }
  return names
}

/** Every exported object of the validator files, to the names it is exported under. */
type SchemaSymbols = Map<object, string[]>

interface ValidatorRead {
  validators: PlanAppDetail['validators']
  symbols: SchemaSymbols
}

/**
 * Validators by exported symbol, with the fields each holds and the identity of the
 * objects, which answers "is this the schema a route registered". Both need the file
 * imported; one that would not import leaves its own symbols unmatchable and their
 * fields unread, never the section unreadable. Barrels are excluded as for models: a
 * re-export belongs to the file that declares it.
 */
async function validatorDetail(root: string, cache: ParseCache, contracts: Set<object>): Promise<ValidatorRead> {
  const files = excludeBarrelFiles(await discoverValidatorFiles(root))
  const symbols: SchemaSymbols = new Map()
  const validators: PlanAppValidatorDetail[] = []
  for (const filePath of files) {
    const file = toPosixRelative(root, filePath)
    const parsed = await cache.get(filePath)
    const names = parsed ? exportedNames(parsed.ast, 'this file') : null
    // One unread file makes every absent name unprovable, as with the controller scan.
    if (names === null) return { validators: { unreadable: `${file} could not be read for its exported schemas` }, symbols }
    const module = moduleNameFromRelPath(file)
    const exported = names.filter((name) => name !== 'default')
    const imported = await importValidatorFile(filePath)
    if (typeof imported === 'string') {
      const fields = { unreadable: `${file} would not import (${imported})` }
      validators.push(...exported.map((name) => ({ name, file, module, unimported: imported, fields })))
      continue
    }
    for (const [name, value] of Object.entries(imported)) {
      if (value === null || typeof value !== 'object' || !contracts.has(value)) continue
      symbols.set(value, [...(symbols.get(value) ?? []), name])
    }
    validators.push(...exported.map((name) => ({ name, file, module, fields: readSchemaFields(name, imported[name]) })))
  }
  return { validators, symbols }
}

/** One validator file's exports, or why it would not import. */
async function importValidatorFile(filePath: string): Promise<Record<string, unknown> | string> {
  try {
    return await withImportTimeout(import(pathToFileURL(filePath).href) as Promise<Record<string, unknown>>, VALIDATOR_IMPORT_TIMEOUT_MS)
  } catch (error) {
    return reasonOf(error)
  }
}

/**
 * Identifiers outside the import and re-export statements, the split `routes-check.ts`
 * makes for the same reason: a leftover import naming a symbol is not a use of it.
 */
function statementIdentifiers(source: string, ast: File): string[] {
  const scrubbed = blankCommentsAndStrings(source, ast)
  const statements = ast.program.body.filter(
    (node) =>
      node.type !== 'ImportDeclaration'
      && node.type !== 'ExportAllDeclaration'
      && !(node.type === 'ExportNamedDeclaration' && node.source),
  )
  return unique(statements.flatMap((node) => scrubbed.slice(node.start ?? 0, node.end ?? 0).match(IDENTIFIER_PATTERN) ?? []))
}

/**
 * Every routes file of the application: the project's, each module's `routes/` directory
 * and each module's single-file `routes.ts` entry, which `discoverModuleRoutesFiles`
 * drops and `make:module` scaffolds — the set `discoverRoutePathFiles` reads for the
 * same reason.
 */
async function routeFileDetail(root: string, cache: ParseCache, routesFile: string | undefined): Promise<PlanAppRouteFile[]> {
  const [moduleRoutes, projectFiles, moduleNames] = await Promise.all([
    discoverModuleRoutesFiles(root),
    discoverRoutesFiles(root),
    listModuleNames(root).catch((): string[] => []),
  ])
  const moduleEntries = await Promise.all(
    moduleNames.map((name) => findFirstExisting(root, moduleRoutesEntryCandidates(`modules/${name}`))),
  )
  const files = unique([
    ...(routesFile === undefined ? [] : [routesFile]),
    ...projectFiles.map((file) => toPosixRelative(root, file)),
    ...moduleRoutes.flatMap((module) => module.files.map((file) => toPosixRelative(root, file))),
    ...moduleEntries.filter((entry): entry is string => entry !== null),
  ])

  const details: PlanAppRouteFile[] = []
  for (const file of files) {
    const parsed = await cache.get(resolve(root, file))
    if (!parsed) continue
    details.push({ file, identifiers: statementIdentifiers(parsed.source, parsed.ast) })
  }
  return details
}

async function policyDetail(root: string, cache: ParseCache): Promise<PlanAppPolicyDetail[]> {
  const policies = await classDetail(root, discoverPolicyFiles)
  return Promise.all(
    policies.map(async (policy) => {
      const parsed = await cache.get(resolve(root, policy.file))
      return { ...policy, abilities: parsed ? readPolicyAbilities(parsed.ast, policy.className) : { unreadable: `${policy.file} could not be parsed` } }
    }),
  )
}

const SIDE_EFFECT_DISCOVERY: Record<PlanAppSideEffectKind, (appRoot: string) => Promise<string[]>> = {
  job: discoverJobFiles,
  event: discoverEventFiles,
  listener: discoverListenerFiles,
  mail: discoverMailFiles,
  notification: discoverNotificationFiles,
}

async function sideEffectDetail(root: string, cache: ParseCache): Promise<Pick<PlanAppDetail, 'sideEffects' | 'sideEffectUsesUnread'>> {
  const kinds = Object.keys(SIDE_EFFECT_DISCOVERY) as PlanAppSideEffectKind[]
  const classes = await Promise.all(kinds.map(async (kind) => [kind, await classDetail(root, SIDE_EFFECT_DISCOVERY[kind])] as const))
  const targets = classes.flatMap(([kind, entries]) => entries.map((entry) => ({ ...entry, kind })))
  const read = await scanSideEffectUses(root, cache, targets).catch((error: unknown) => ({ unreadable: reasonOf(error) }))
  const uses = 'unreadable' in read ? undefined : read.byFile
  const sideEffects = Object.fromEntries(
    classes.map(([kind, entries]) => [kind, entries.map((entry) => ({ ...entry, usedIn: [], unprovenIn: [], mentionedIn: [], ...uses?.get(entry.file) }))]),
  ) as PlanAppDetail['sideEffects']
  return { sideEffects, ...unreadUses(kinds, read) }
}

function unreadUses(kinds: PlanAppSideEffectKind[], read: SideEffectUses | PlanAppUnreadable): Pick<PlanAppDetail, 'sideEffectUsesUnread'> {
  const everyKind = (reason: string) => ({ sideEffectUsesUnread: Object.fromEntries(kinds.map((kind) => [kind, reason])) })
  if ('unreadable' in read) return everyKind(read.unreadable)
  if (read.unparsed.length > 0) return everyKind(`${read.unparsed.join(', ')} could not be parsed`)
  const discovers = read.discoversListeners[0]
  return discovers ? { sideEffectUsesUnread: { listener: `${discovers} constructs AutoDiscovery, which finds listeners by directory rather than by name` } } : {}
}

/** The export `resolveRegistrar()` would pick from a routes file, by the loader's own order. */
function registrarExport(ast: File): string | null {
  const names = exportedNames(ast, 'anywhere')
  if (names === null) return null
  return (
    REGISTRAR_EXPORT_NAMES.find((name) => names.includes(name))
    ?? names.find((name) => REGISTRAR_PATTERN.test(name))
    ?? null
  )
}

/**
 * Whether `createApp()` is handed what the CLI loaded. The route graph comes from
 * executing the entry registrar and from a directory scan of `modules/`, neither of
 * which asks the application; this reads the entry's `routes` and `modules` options.
 */
async function mountDetail(root: string, cache: ParseCache, input: PlanAppDetailInput): Promise<PlanAppDetail['mounts']> {
  const modules = unique(input.provenance.filter((name): name is string => name !== null))
  const all = (mount: PlanAppMount): PlanAppDetail['mounts'] => ({
    entry: mount,
    modules: Object.fromEntries(modules.map((name) => [name, mount])),
  })

  const entryPath = await resolveAppEntry(root)
  if (entryPath === null) return all({ unconfirmed: 'the application has no src/app.ts or app.ts to read createApp() from' })
  const parsed = await cache.get(resolve(root, entryPath))
  const options = parsed ? createAppOptions(parsed.ast.program) : null
  if (!parsed || !options) return all({ unconfirmed: `${entryPath} does not call createApp() with an object literal` })

  const imports = importsByLocal(parsed.ast.program.body)
  const hasSpread = options.properties.some((property) => property.type !== 'ObjectProperty')
  const mountState = (name: string) => moduleMountState(options, parsed.ast.program, root, resolve(root, entryPath), resolve(root, 'modules', name))
  const importedFile = (node: Node | null | undefined): { base: string; imported: string } | null => {
    const value = node ? unwrapTypeAssertion(node) : undefined
    const entry = value?.type === 'Identifier' ? imports.get(value.name) : undefined
    const base = entry ? specifierBase(root, resolve(root, entryPath), entry.source) : null
    return entry && base !== null ? { base: withoutExtension(base), imported: entry.imported || 'default' } : null
  }

  return {
    entry: await entryMount(),
    modules: Object.fromEntries(modules.map((name) => [name, moduleMount(name)])),
  }

  async function entryMount(): Promise<PlanAppMount> {
    if (input.routesFile === undefined) return { unconfirmed: 'the application has no routes entry file' }
    const declared = propertyValue(options, 'routes')
    if (declared === undefined) {
      return { unconfirmed: hasSpread ? `createApp() in ${entryPath} spreads its options, which may carry routes` : `createApp() in ${entryPath} passes no routes` }
    }
    const imported = importedFile(declared)
    if (!imported) return { unconfirmed: `createApp({ routes }) in ${entryPath} is not a registrar imported from a file` }
    if (imported.base !== withoutExtension(resolve(root, input.routesFile))) {
      return { unconfirmed: `createApp({ routes }) in ${entryPath} imports ${relative(root, imported.base)}, not ${input.routesFile}` }
    }
    const routesAst = await cache.get(resolve(root, input.routesFile))
    const loaded = routesAst ? registrarExport(routesAst.ast) : null
    if (loaded !== imported.imported) {
      return { unconfirmed: `createApp({ routes }) takes "${imported.imported}" from ${input.routesFile}, and the CLI loaded ${loaded ? `"${loaded}"` : 'a registrar it could not name'}` }
    }
    return 'mounted'
  }

  function moduleMount(name: string): PlanAppMount {
    switch (mountState(name)) {
      case 'mounted': return 'mounted'
      case 'no-modules': return { unconfirmed: `createApp() in ${entryPath} lists no modules` }
      case 'not-array': return { unconfirmed: `createApp({ modules }) in ${entryPath} is not an array literal` }
      case 'untraceable': return { unconfirmed: `createApp({ modules }) in ${entryPath} holds an entry this cannot trace to a file` }
      case 'unlisted': return { unconfirmed: `createApp({ modules }) in ${entryPath} does not list modules/${name}` }
    }
  }

}
