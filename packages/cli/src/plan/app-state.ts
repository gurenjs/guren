/**
 * The application state the plan reference checks (RFC 0030 §2) read, through the
 * scanners the other commands already use.
 *
 * Every section is a list **or** the reason it could not be read. Some readers
 * answer `[]` both for "this app has none" and for a directory that would not open,
 * and the two point opposite ways here: an empty list clears every `add` of a
 * collision *and* fails every `existing` target. The loader decides which it is; a
 * section it cannot decide reports `unreadable`, which no check passes or fails.
 */

import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { RouteDefinition } from '@guren/server'
import {
  classNameFromPath,
  discoverModelFiles,
  discoverPolicyFiles,
  discoverResourceFiles,
  excludeBarrelFiles,
  formatTruncatedList,
  isDefinitelyAbsent,
  listAppRoots,
  moduleNameFor,
  VALIDATORS_DIR,
  type AppRoot,
} from '../discovery'
import { routeDefinitionToContextRoute, type ContextRoute } from '../context-route'
import { parseControllerMethods, type ControllerMethodScan } from '../controller-methods'
import { listInertiaPageIds } from '../inertia-pages'
import { parseModelFile } from '../model-parser'
import { parseSchemaTables, schemaPathFor } from '../schema-parser'
import { isConfirmedApiOnlyApp } from '../app-surface'
import { loadRouteDefinitions, resolveRoutesFile } from '../load-routes'
import { loadPlanAppDetail, readValidatorExports, type PlanAppDetail, type PlanAppValidatorExports } from './app-detail'
import { discoverPlanFiles } from './discovery'
import type { PlanImpactSources } from './impact'
import { loadPlanImpactSources } from './impact-sources'
import { ParseCache } from '../parse-cache'
import { isUnreadable, type PlanAppUnreadable } from './unreadable'

const CONTROLLERS_DIR = 'app/Http/Controllers'

export { isUnreadable, type PlanAppUnreadable }

/**
 * The app root something sits in: a module name, or `null` for the project root. A plan
 * element names the same thing with its optional `module`, and comparing the two is
 * what keeps a same-named element in another root from satisfying it.
 */
export type PlanAppScope = string | null

/** How a message names an app root. */
export function scopeName(module: PlanAppScope | undefined): string {
  return module ? `modules/${module}` : 'the project root'
}

export interface PlanAppName {
  name: string
  module: PlanAppScope
}

export type PlanAppNames = PlanAppName[] | PlanAppUnreadable

/** The names alone, for a reader that judges a section without its app roots. */
export function appNames(section: ReadonlyArray<PlanAppName>): string[] {
  return section.map((entry) => entry.name)
}

export interface PlanAppTable {
  /** Exported table identifier in `db/schema.ts`. */
  identifier: string
  /** The app root whose `db/schema.ts` declares it. */
  module: PlanAppScope
  /** The SQL table name, when the declaration states one. */
  tableName?: string
  /** Model property names, a lower bound for {@link COLUMNS_ARE_A_LOWER_BOUND}. */
  columns: string[]
}

/** The table `name` means in one app root: a plan names a table by identifier or SQL name alike. */
export function findTable(tables: ReadonlyArray<PlanAppTable>, name: string, module: PlanAppScope): PlanAppTable | undefined {
  return tables.find((table) => table.module === module && declaresTable(table, name))
}

export function declaresTable(table: PlanAppTable, name: string): boolean {
  return table.identifier === name || table.tableName === name
}

/**
 * Why a name absent from {@link PlanAppTable.columns} is unconfirmed rather than
 * missing. Stated once: the checks quote it, and the reason is the parser's.
 */
export const COLUMNS_ARE_A_LOWER_BOUND =
  "The schema parser reports a table's columns as a lower bound: a spread column goes unreported."

/** Why a validator name absent from the section is unconfirmed rather than missing, stated once as above. */
export const VALIDATORS_ARE_A_LOWER_BOUND =
  `Validators are read from what the files under ${VALIDATORS_DIR}/ declare and export; a schema declared or re-exported elsewhere is not seen.`

export interface PlanAppRoute {
  name?: string
  method: string
  path: string
}

export interface PlanAppState {
  /** Model class names. */
  models: PlanAppNames
  /** Controller class names, as declared rather than as their files are named. */
  controllers: PlanAppNames
  /** `ClassName.action` for every action a controller declares. */
  actions: PlanAppNames
  resources: PlanAppNames
  policies: PlanAppNames
  /**
   * Inertia page ids, e.g. `posts/Show`. Every page sits in the project's own
   * `resources/js/pages`, a module's under its name, so the id carries the scope and
   * the entry's own root is `null` throughout.
   */
  pages: PlanAppNames
  /** Exported schema symbols of the validator files, which is how a plan names a validator. */
  validators: PlanAppNames
  routes: PlanAppRoute[] | PlanAppUnreadable
  tables: PlanAppTable[] | PlanAppUnreadable
  /**
   * From `isConfirmedApiOnlyApp()`, which answers positive evidence only: `false`
   * is "not established", never "this app renders pages".
   */
  apiOnly: boolean
  /** What `plan:status` compares against; present only when the loader was asked for it. */
  detail?: PlanAppDetail
  /** What Impact reads (RFC 0030 §2); present only when the loader was asked for it. */
  impact?: PlanImpactSources
}

/**
 * Builds {@link PlanAppState} from a project directory: the only filesystem-facing
 * half of the checks. Each scanner is called directly rather than through
 * `generateContext()`, which walks the controller tree a second time and Babel-parses
 * every console command for sections no check here reads.
 */
export async function loadPlanAppState(
  cwd: string,
  /**
   * `detail` also imports `db/schema.ts` (RFC 0030 §6), which `plan:render` has no reason to
   * run; `impact` adds the static readers Impact needs and imports nothing.
   */
  options: { routesFile?: string; detail?: boolean; impact?: boolean } = {},
): Promise<PlanAppState> {
  const root = resolve(cwd)
  const roots = await listAppRoots(root).catch((): AppRoot[] => [])

  // One cache for the controller, validator and Impact column scans, which parse the same files.
  const cache = new ParseCache()
  const [apiOnly, models, resources, policies, pages, validators, routes, controllers, tables] = await Promise.all([
    isConfirmedApiOnlyApp(root).catch(() => false),
    modelSection(root),
    classSection(root, discoverResourceFiles),
    classSection(root, discoverPolicyFiles),
    pageSection(root),
    validatorSections(root, roots, cache),
    routeSection(root, options.routesFile),
    controllerSections(root, cache),
    tableSection(root, roots),
  ])

  const state: PlanAppState = {
    models,
    controllers: controllers.classes,
    actions: controllers.actions,
    resources,
    policies,
    pages,
    validators: validators.names,
    routes: isUnreadable(routes.routes) ? routes.routes : routes.routes.map(({ name, method, path }) => ({ name, method, path })),
    tables,
    apiOnly,
  }
  if (options.impact) {
    // Preserve the directory-level reasons alongside the individual reader verdicts.
    const [controllersDir, testsDir] = await Promise.all([probeDirectory(roots, CONTROLLERS_DIR), probeDirectory(roots, 'tests')])
    state.impact = await loadPlanImpactSources({
      root,
      cache,
      routes: routes.routes,
      definitions: routes.definitions,
      provenance: routes.provenance,
      moduleWarnings: routes.moduleWarnings,
      controllers: controllersDir ? { unreadable: controllersDir } : controllers.scan,
      sections: { models, resources, policies, pages, ...(testsDir ? { tests: { unreadable: testsDir } } : {}) },
    })
  }
  if (!options.detail) return state

  const detail = await loadPlanAppDetail({
    root,
    routesFile: routes.file,
    routes: routes.routes,
    definitions: routes.definitions,
    provenance: routes.provenance,
    moduleWarnings: routes.moduleWarnings,
    controllers: controllers.scan,
    pages: isUnreadable(pages) ? pages : appNames(pages),
    models: isUnreadable(models) ? models : undefined,
    validators: validators.exports,
  })
  return { ...state, detail }
}

/**
 * The reason a section's directory would not open, for the discoverers that answer
 * `[]` either way. Only the directory itself is probed, not the tree beneath it: an
 * unreadable nested directory still under-reports, which no cheap probe catches.
 */
async function probeDirectory(roots: ReadonlyArray<AppRoot>, relativeDir: string): Promise<string | undefined> {
  const failures = await Promise.all(
    roots.map(async (root) => {
      if (await isDefinitelyAbsent(root.dir, relativeDir)) return undefined
      try {
        await readdir(resolve(root.dir, relativeDir))
        return undefined
      } catch (error) {
        return `${relativeDir} would not open (${error instanceof Error ? error.message : String(error)})`
      }
    }),
  )
  return failures.find((failure) => failure !== undefined)
}

async function modelSection(cwd: string): Promise<PlanAppNames> {
  const files = await discoverPlanFiles(cwd, discoverModelFiles)
  if (isUnreadable(files)) return files
  const parsed = await Promise.all(files.map(async (file) => ({ file, info: await parseModelFile(file) })))
  return parsed
    .flatMap(({ file, info }) => (info ? [{ name: info.className, module: moduleNameFor(cwd, file) }] : []))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Code-unit order, which is what `sort()` gives bare names. */
function byName(a: PlanAppName, b: PlanAppName): number {
  if (a.name === b.name) return 0
  return a.name < b.name ? -1 : 1
}

/** A section named after the class each discovered file declares, as `guren context` names them. */
async function classSection(
  cwd: string,
  discover: (appRoot: string) => Promise<string[]>,
): Promise<PlanAppNames> {
  const files = await discoverPlanFiles(cwd, discover)
  if (isUnreadable(files)) return files
  return excludeBarrelFiles(files)
    .map((file) => ({ name: classNameFromPath(file), module: moduleNameFor(cwd, file) }))
    .sort(byName)
}

/** The names the §2 checks judge, and the reading `plan:status`'s detail imports the same files from. */
async function validatorSections(
  cwd: string,
  roots: ReadonlyArray<AppRoot>,
  cache: ParseCache,
): Promise<{ names: PlanAppNames; exports: PlanAppValidatorExports[] | PlanAppUnreadable }> {
  const [probe, exports] = await Promise.all([probeDirectory(roots, VALIDATORS_DIR), readValidatorExports(cwd, cache)])
  if (probe) return { names: { unreadable: probe }, exports }
  if (isUnreadable(exports)) return { names: exports, exports }
  return { names: exports.flatMap(({ module, names }) => names.map((name) => ({ name, module }))).sort(byName), exports }
}

async function pageSection(cwd: string): Promise<PlanAppNames> {
  const pagesDir = 'resources/js/pages'
  const [probe, pages] = await Promise.all([
    probeDirectory([{ dir: cwd, module: null }], pagesDir),
    listInertiaPageIds(cwd),
  ])
  return probe ? { unreadable: probe } : pages.map((name) => ({ name, module: null }))
}

/**
 * Controller classes and their actions from the one controller scan, which reports
 * the files it could not read. A partial scan makes both sections unreadable: a
 * class missing because its file did not parse is indistinguishable from one the
 * app does not have.
 */
async function controllerSections(
  cwd: string,
  cache: ParseCache,
): Promise<{ classes: PlanAppNames; actions: PlanAppNames; scan: ControllerMethodScan | PlanAppUnreadable }> {
  let scan: ControllerMethodScan
  try {
    scan = await parseControllerMethods(cwd, cache)
  } catch (error) {
    const unreadable = { unreadable: error instanceof Error ? error.message : String(error) }
    return { classes: unreadable, actions: unreadable, scan: unreadable }
  }

  const skipped = [...scan.unreadableFiles, ...scan.unparsedFiles]
  if (skipped.length > 0) {
    const unreadable = {
      unreadable: `${skipped.length} controller file(s) did not parse: ${formatTruncatedList(skipped)}`,
    }
    return { classes: unreadable, actions: unreadable, scan: unreadable }
  }
  const scopeOf = (filePath: string): PlanAppScope => moduleNameFor(cwd, resolve(cwd, filePath))
  return {
    classes: [...scan.classFiles].map(([className, file]) => ({ name: className, module: scopeOf(file) })),
    actions: [...scan.methods].map(([key, info]) => ({ name: key, module: scopeOf(info.filePath) })),
    scan,
  }
}

interface RouteSection {
  routes: ContextRoute[] | PlanAppUnreadable
  /** What `routes` was rendered from, in the same order; the detail needs the live schemas. */
  definitions: RouteDefinition[] | undefined
  /** The entry that was loaded, app-relative; `undefined` when the app has none. */
  file: string | undefined
  /** One entry per route, in order: the module that declared it, or `null` for the entry registrar. */
  provenance: Array<string | null>
  moduleWarnings: string[]
}

async function routeSection(cwd: string, routesFile: string | undefined): Promise<RouteSection> {
  const target = await resolveRoutesFile(cwd, routesFile)
  const section: RouteSection = { routes: [], definitions: undefined, file: undefined, provenance: [], moduleWarnings: [] }
  if (target.silentlyAbsent) return section

  try {
    const definitions = await loadRouteDefinitions(resolve(cwd, target.path), cwd, section.moduleWarnings, section.provenance)
    return { ...section, file: target.path, definitions, routes: definitions.map(routeDefinitionToContextRoute) }
  } catch (error) {
    // Presence, not truthiness: `new Error()` carries '', and a discarded error reports
    // the routes file as an app with no routes rather than as one nobody could read.
    const reason = (error instanceof Error ? error.message : String(error)) || 'the routes file threw without a message'
    return { ...section, file: target.path, routes: { unreadable: reason } }
  }
}

/**
 * `parseSchemaTables()` reports a missing file and an unparsable one the same way,
 * so a root whose `db/schema.ts` is present and contributed no table reads as
 * unreadable — per root, since one readable root would otherwise make a module's
 * unread schema look like a module with no tables.
 */
async function tableSection(cwd: string, roots: ReadonlyArray<AppRoot>): Promise<PlanAppState['tables']> {
  let parsed: Awaited<ReturnType<typeof parseSchemaTables>>
  try {
    parsed = await parseSchemaTables(cwd)
  } catch (error) {
    return { unreadable: error instanceof Error ? error.message : String(error) }
  }

  for (const root of roots) {
    if (await isDefinitelyAbsent(root.dir, 'db/schema.ts')) continue
    if (parsed.some((table) => table.module === root.module)) continue
    return { unreadable: `${schemaPathFor(root.module)} declared no table this parser could read` }
  }

  return parsed.map((table) => ({
    identifier: table.identifier,
    tableName: table.tableName,
    module: table.module,
    columns: table.columns.map((column) => column.name),
  }))
}
