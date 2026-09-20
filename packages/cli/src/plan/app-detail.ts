/**
 * What `plan:status` (RFC 0030 §6) compares a plan with, beyond the names the §2 checks
 * read: each reader's properties, and the evidence that something is mounted. Built by
 * `loadPlanAppState({ detail: true })` from the same scans, so the two commands cannot
 * disagree about what the application holds. Every section is a list or the reason it
 * could not be read; a reader that answers a lower bound says so beside its list.
 */

import { relative, resolve } from 'node:path'
import type { File, Node, Statement } from '@babel/types'

import { unwrapTypeAssertion, propertyValue, topLevelDeclaration, walk, memberKeyName } from '../ast-walk'
import { createAppOptions } from '../config-check'
import type { ContextRoute } from '../context-route'
import { blankCommentsAndStrings, type ControllerMethodScan } from '../controller-methods'
import {
  classNameFromPath,
  discoverEventFiles,
  discoverJobFiles,
  discoverListenerFiles,
  discoverModelFiles,
  discoverModuleRoutesFiles,
  discoverPolicyFiles,
  discoverResourceFiles,
  discoverRoutesFiles,
  discoverValidatorFiles,
  excludeBarrelFiles,
  moduleNameFor,
  moduleNameFromRelPath,
  toPosixRelative,
} from '../discovery'
import { extractInertiaPageRefs, describeInertiaPagePropKeys } from '../inertia-pages'
import { discoverParsedModels, type ModelRelationship } from '../model-parser'
import type { PagePropKeys } from '../page-props-extractor'
import { ParseCache } from '../parse-cache'
import { resolveAppEntry } from '../provider-registrar'
import { REGISTRAR_EXPORT_NAMES, REGISTRAR_PATTERN, specifierName } from '../route-registrar'
import { importsByLocal, specifierBase } from '../schema-binding'
import { readSchemaTables, type SourcedSchemaTable } from '../schema-runtime'
import type { PlanAppUnreadable } from './app-state'

/** `mounted`, or why this command could not confirm it. Absence of evidence is never `mounted`. */
export type PlanAppMount = 'mounted' | { unconfirmed: string }

/**
 * The app root a file sits in: a module name, or `null` for the project root. A plan
 * element names the same thing with its optional `module`, and comparing the two is
 * what keeps a same-named element in another root from satisfying it.
 */
export type PlanAppScope = string | null

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
}

export interface PlanAppModelDetail {
  className: string
  module: PlanAppScope
  /** The table identifier the class binds, when the parser could read it. */
  table?: string
  relationships: ModelRelationship[]
  fillable: string[] | 'unreadable' | null
}

export interface PlanAppActionDetail {
  /** `ClassName.action`. */
  key: string
  module: PlanAppScope
  /** Inertia page ids the body returns. */
  pages: string[]
  /** `this.<member>(` calls in the body, comments and strings excluded. */
  calls: string[]
  /** Abilities passed to `this.authorize()` / `this.can()` as a string literal. */
  abilities: string[]
  /** Identifiers the body mentions, comments and strings excluded: a mention, not a use. */
  identifiers: string[]
  /** Schemas handed to `this.validateBody/Query/Params(`, which is a use. */
  validates: string[]
}

export interface PlanAppPageDetail {
  id: string
  props: PagePropKeys
}

export interface PlanAppValidatorDetail {
  /** The exported schema symbol, which is how a plan names a validator. */
  name: string
  file: string
  module: PlanAppScope
}

/** A class a plan names and a directory scan discovers, for the kinds with no other reader. */
export interface PlanAppClassDetail {
  className: string
  module: PlanAppScope
}

export interface PlanAppRouteFile {
  file: string
  /**
   * The routes file the CLI loaded, which is the only one `mounts.entry` is evidence
   * about: a module's registrar is named by `defineModule({ routes })`, and picking
   * its entry by filename would be a guess.
   */
  entry: boolean
  /** Identifiers outside the import and re-export statements: a mention, not a use. */
  identifiers: string[]
  /** Schemas a route contract's `body` / `params` / `query` names, which is a use. */
  contractIdentifiers: string[]
}

export type PlanAppSideEffectKind = 'job' | 'event' | 'listener'

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
  policies: PlanAppClassDetail[]
  routeFiles: PlanAppRouteFile[]
  sideEffects: Record<PlanAppSideEffectKind, PlanAppClassDetail[]>
}

/** What `loadPlanAppState()` already holds when it asks for the detail. */
export interface PlanAppDetailInput {
  root: string
  /** The entry routes file that was loaded, app-relative; `undefined` when the app has none. */
  routesFile: string | undefined
  routes: ContextRoute[] | PlanAppUnreadable
  provenance: Array<string | null>
  moduleWarnings: string[]
  controllers: ControllerMethodScan | PlanAppUnreadable
  pages: string[] | PlanAppUnreadable
  models: PlanAppUnreadable | undefined
}

const IDENTIFIER_PATTERN = /[A-Za-z_$][\w$]*/g
const MEMBER_CALL_PATTERN = /\bthis\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g
const ABILITY_PATTERN = /\bthis\s*\.\s*(?:authorize|can)\s*\(\s*(['"`])([^'"`]+)\1/g
const VALIDATE_CALL_PATTERN = /\bthis\s*\.\s*validate(?:Body|Query|Params)\s*\(\s*([A-Za-z_$][\w$]*)/g

/** Route contract keys (`RouteContractOptions`) whose value is a schema. */
const CONTRACT_SCHEMA_KEYS = new Set(['body', 'params', 'query'])

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)]
}

export async function loadPlanAppDetail(input: PlanAppDetailInput): Promise<PlanAppDetail> {
  const { root } = input
  const cache = new ParseCache()

  const [tables, models, pages, validators, resources, policies, routeFiles, sideEffects, mounts] = await Promise.all([
    tableDetail(root),
    modelDetail(root, input.models),
    pageDetail(root, input.pages),
    validatorDetail(root, cache),
    classDetail(root, discoverResourceFiles),
    classDetail(root, discoverPolicyFiles),
    routeFileDetail(root, cache, input.routesFile),
    sideEffectDetail(root),
    mountDetail(root, cache, input),
  ])

  return {
    routes: routeDetail(input),
    ...(input.moduleWarnings.length > 0 ? { routesIncomplete: input.moduleWarnings.join(' ') } : {}),
    mounts,
    tables,
    ...models,
    ...actionDetail(root, input.controllers),
    pages,
    validators,
    resources,
    policies,
    routeFiles,
    sideEffects,
  }
}

function routeDetail(input: PlanAppDetailInput): PlanAppDetail['routes'] {
  if (!Array.isArray(input.routes)) return input.routes
  return input.routes.map((route, index) => ({
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
  }))
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
      models: models.map(({ info, module }) => ({
        className: info.className,
        module,
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

function actionDetail(
  root: string,
  controllers: ControllerMethodScan | PlanAppUnreadable,
): Pick<PlanAppDetail, 'actions' | 'controllers' | 'controllerCollisions'> {
  if (!('methods' in controllers)) return { actions: controllers, controllers, controllerCollisions: [] }
  const actions = [...controllers.methods].map(([key, info]): PlanAppActionDetail => {
    // A page id and an ability are string contents, which only the raw body holds; the
    // blanked body, offsets preserved, says whether a match there is code or a comment.
    const isCode = (index: number): boolean => info.body.startsWith('this', index)
    return {
      key,
      module: moduleNameFor(root, resolve(root, info.filePath)),
      pages: extractInertiaPageRefs(info.rawBody, isCode).map((ref) => ref.id),
      calls: unique([...info.body.matchAll(MEMBER_CALL_PATTERN)].map((match) => match[1]!)),
      abilities: unique([...info.rawBody.matchAll(ABILITY_PATTERN)].filter((match) => isCode(match.index)).map((match) => match[2]!)),
      identifiers: unique(info.body.match(IDENTIFIER_PATTERN) ?? []),
      validates: unique([...info.body.matchAll(VALIDATE_CALL_PATTERN)].map((match) => match[1]!)),
    }
  })
  return {
    actions,
    controllers: [...controllers.classFiles].map(([className, relPath]) => ({ className, module: moduleNameFor(root, resolve(root, relPath)) })),
    controllerCollisions: unique(controllers.collisions.map((collision) => collision.className)),
  }
}

/** Classes a directory scan discovers, each tagged with the app root it came from. */
async function classDetail(root: string, discover: (appRoot: string) => Promise<string[]>): Promise<PlanAppClassDetail[]> {
  const files = excludeBarrelFiles(await discover(root).catch((): string[] => []))
  return files.map((file) => ({ className: classNameFromPath(file), module: moduleNameFor(root, file) }))
}

async function pageDetail(root: string, pages: string[] | PlanAppUnreadable): Promise<PlanAppDetail['pages']> {
  if (!Array.isArray(pages)) return pages
  return Promise.all(
    pages.map(async (id) => ({
      id,
      props: (await describeInertiaPagePropKeys(root, id)) ?? { status: 'unreadable' as const, reason: 'the page has no component file' },
    })),
  )
}

/** Names a module exports with `export const` / `export function`; `null` when an export form hides some. */
function exportedNames(ast: File): string[] | null {
  const names: string[] = []
  for (const node of ast.program.body) {
    if (node.type === 'ExportAllDeclaration') return null
    if (node.type === 'ExportDefaultDeclaration') names.push('default')
    if (node.type !== 'ExportNamedDeclaration') continue
    for (const specifier of node.specifiers) {
      if (specifier.type === 'ExportSpecifier') names.push(specifierName(specifier.exported))
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

async function validatorDetail(root: string, cache: ParseCache): Promise<PlanAppDetail['validators']> {
  const files = await discoverValidatorFiles(root)
  const validators: PlanAppValidatorDetail[] = []
  for (const filePath of files) {
    const file = toPosixRelative(root, filePath)
    const parsed = await cache.get(filePath)
    const names = parsed ? exportedNames(parsed.ast) : null
    // One unread file makes every absent name unprovable, as with the controller scan.
    if (names === null) return { unreadable: `${file} could not be read for its exported schemas` }
    const module = moduleNameFromRelPath(file)
    validators.push(...names.filter((name) => name !== 'default').map((name) => ({ name, file, module })))
  }
  return validators
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
 * Schemas a route contract names. The object literal is not required to be a route
 * option argument: `resource()` expansions and option objects built by a helper carry
 * the same keys, and a narrower test would miss them.
 */
function contractIdentifiers(ast: File): string[] {
  const names: string[] = []
  walk(ast.program, (node) => {
    if (node.type !== 'ObjectProperty') return
    const key = memberKeyName(node as unknown as { computed?: boolean; key: { type: string; name?: string; value?: unknown } })
    if (key === undefined || !CONTRACT_SCHEMA_KEYS.has(key)) return
    const value = unwrapTypeAssertion(node.value as Node)
    if (value.type === 'Identifier') names.push(value.name)
  })
  return unique(names)
}

async function routeFileDetail(root: string, cache: ParseCache, routesFile: string | undefined): Promise<PlanAppRouteFile[]> {
  const moduleRoutes = await discoverModuleRoutesFiles(root)
  const files = unique([
    ...(routesFile === undefined ? [] : [routesFile]),
    ...(await discoverRoutesFiles(root)).map((file) => toPosixRelative(root, file)),
    ...moduleRoutes.flatMap((module) => module.files.map((file) => toPosixRelative(root, file))),
  ])

  const details: PlanAppRouteFile[] = []
  for (const file of files) {
    const parsed = await cache.get(resolve(root, file))
    if (!parsed) continue
    details.push({
      file,
      entry: file === routesFile,
      identifiers: statementIdentifiers(parsed.source, parsed.ast),
      contractIdentifiers: contractIdentifiers(parsed.ast),
    })
  }
  return details
}

async function sideEffectDetail(root: string): Promise<PlanAppDetail['sideEffects']> {
  const [job, event, listener] = await Promise.all([
    classDetail(root, discoverJobFiles),
    classDetail(root, discoverEventFiles),
    classDetail(root, discoverListenerFiles),
  ])
  return { job, event, listener }
}

/** The export `resolveRegistrar()` would pick from a routes file, by the loader's own order. */
function registrarExport(ast: File): string | null {
  const names = exportedNames(ast)
  if (names === null) return null
  return (
    REGISTRAR_EXPORT_NAMES.find((name) => names.includes(name))
    ?? names.find((name) => REGISTRAR_PATTERN.test(name))
    ?? null
  )
}

function withoutExtension(path: string): string {
  return path.replace(/\.[cm]?[jt]sx?$/u, '')
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
    const declared = propertyValue(options, 'modules')
    const array = declared ? unwrapTypeAssertion(declared) : undefined
    if (array?.type !== 'ArrayExpression') {
      return { unconfirmed: declared === undefined && !hasSpread ? `createApp() in ${entryPath} lists no modules` : `createApp({ modules }) in ${entryPath} is not an array literal` }
    }
    const moduleDir = resolve(root, 'modules', name)
    let opaque = false
    for (const element of array.elements) {
      const imported = importedFile(element)
      if (!imported) opaque = true
      else if (imported.base === moduleDir || imported.base === resolve(moduleDir, 'index')) return 'mounted'
    }
    return { unconfirmed: opaque ? `createApp({ modules }) in ${entryPath} holds an entry this cannot trace to a file` : `createApp({ modules }) in ${entryPath} does not list modules/${name}` }
  }
}
