/**
 * The application state the plan reference checks (RFC 0030 §2) read, through the
 * scanners the other commands already use.
 *
 * Every section is a list **or** the reason it could not be read. The discoverers
 * answer `[]` both for "this app has none" and for a directory that would not open,
 * and the two point opposite ways here: an empty list clears every `add` of a
 * collision *and* fails every `existing` target. The loader decides which it is; a
 * section it cannot decide reports `unreadable`, which no check passes or fails.
 */

import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  classNameFromPath,
  discoverModelFiles,
  discoverPolicyFiles,
  discoverResourceFiles,
  excludeBarrelFiles,
  formatTruncatedList,
  isDefinitelyAbsent,
  listAppRoots,
  MODELS_DIR,
  RESOURCES_DIR,
  type AppRoot,
} from '../discovery'
import { routeDefinitionToContextRoute, type ContextRoute } from '../context-route'
import { parseControllerMethods, type ControllerMethodScan } from '../controller-methods'
import { listInertiaPageIds } from '../inertia-pages'
import { parseModelFile } from '../model-parser'
import { parseSchemaTables, schemaPathFor } from '../schema-parser'
import { isConfirmedApiOnlyApp } from '../app-surface'
import { loadRouteDefinitions, resolveRoutesFile } from '../load-routes'
import { loadPlanAppDetail, type PlanAppDetail } from './app-detail'

const POLICIES_DIR = 'app/Policies'

/** A section the scanners could not read, carrying why. */
export interface PlanAppUnreadable {
  unreadable: string
}

export type PlanAppNames = string[] | PlanAppUnreadable

export interface PlanAppTable {
  /** Exported table identifier in `db/schema.ts`. */
  identifier: string
  /** The SQL table name, when the declaration states one. */
  tableName?: string
  /** Model property names, a lower bound for {@link COLUMNS_ARE_A_LOWER_BOUND}. */
  columns: string[]
}

/**
 * Why a name absent from {@link PlanAppTable.columns} is unconfirmed rather than
 * missing. Stated once: the checks quote it, and the reason is the parser's.
 */
export const COLUMNS_ARE_A_LOWER_BOUND =
  "The schema parser reports a table's columns as a lower bound: a spread column goes unreported."

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
  /** Inertia page ids, e.g. `posts/Show`. */
  pages: PlanAppNames
  /**
   * Always `unreadable` from {@link loadPlanAppState}: a plan names a validator by
   * its exported schema symbol and the discoverer yields file basenames, so the two
   * do not compare. Validators are held by the internal reference checks instead.
   */
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
}

export function isUnreadable<T>(section: T[] | PlanAppUnreadable): section is PlanAppUnreadable {
  return !Array.isArray(section)
}

const VALIDATOR_SECTION_REASON =
  'a plan names a validator by its exported schema symbol, which no scanner resolves from a file name'

/**
 * Builds {@link PlanAppState} from a project directory: the only filesystem-facing
 * half of the checks. Each scanner is called directly rather than through
 * `generateContext()`, which walks the controller tree a second time and Babel-parses
 * every console command for sections no check here reads.
 */
export async function loadPlanAppState(
  cwd: string,
  /** `detail` also imports `db/schema.ts` (RFC 0030 §6), which `plan:render` has no reason to run. */
  options: { routesFile?: string; detail?: boolean } = {},
): Promise<PlanAppState> {
  const root = resolve(cwd)
  const roots = await listAppRoots(root).catch((): AppRoot[] => [])

  const [apiOnly, models, resources, policies, pages, routes, controllers, tables] = await Promise.all([
    isConfirmedApiOnlyApp(root).catch(() => false),
    modelSection(root, roots),
    classSection(root, roots, RESOURCES_DIR, discoverResourceFiles),
    classSection(root, roots, POLICIES_DIR, discoverPolicyFiles),
    pageSection(root),
    routeSection(root, options.routesFile),
    controllerSections(root),
    tableSection(root, roots),
  ])

  const state: PlanAppState = {
    models,
    controllers: controllers.classes,
    actions: controllers.actions,
    resources,
    policies,
    pages,
    validators: { unreadable: VALIDATOR_SECTION_REASON },
    routes: isUnreadable(routes.routes) ? routes.routes : routes.routes.map(({ name, method, path }) => ({ name, method, path })),
    tables,
    apiOnly,
  }
  if (!options.detail) return state

  const detail = await loadPlanAppDetail({
    root,
    routesFile: routes.file,
    routes: routes.routes,
    provenance: routes.provenance,
    moduleWarnings: routes.moduleWarnings,
    controllers: controllers.scan,
    pages,
    models: isUnreadable(models) ? models : undefined,
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

async function modelSection(cwd: string, roots: ReadonlyArray<AppRoot>): Promise<PlanAppNames> {
  const [probe, files] = await Promise.all([probeDirectory(roots, MODELS_DIR), discoverModelFiles(cwd)])
  if (probe) return { unreadable: probe }
  const parsed = await Promise.all(files.map((file) => parseModelFile(file)))
  return parsed.flatMap((info) => (info ? [info.className] : [])).sort((a, b) => a.localeCompare(b))
}

/** A section named after the class each discovered file declares, as `guren context` names them. */
async function classSection(
  cwd: string,
  roots: ReadonlyArray<AppRoot>,
  relativeDir: string,
  discover: (appRoot: string) => Promise<string[]>,
): Promise<PlanAppNames> {
  const [probe, files] = await Promise.all([probeDirectory(roots, relativeDir), discover(cwd)])
  if (probe) return { unreadable: probe }
  return excludeBarrelFiles(files).map(classNameFromPath).sort()
}

async function pageSection(cwd: string): Promise<PlanAppNames> {
  const pagesDir = 'resources/js/pages'
  const [probe, pages] = await Promise.all([
    probeDirectory([{ dir: cwd, module: null }], pagesDir),
    listInertiaPageIds(cwd),
  ])
  return probe ? { unreadable: probe } : pages
}

/**
 * Controller classes and their actions from the one controller scan, which reports
 * the files it could not read. A partial scan makes both sections unreadable: a
 * class missing because its file did not parse is indistinguishable from one the
 * app does not have.
 */
async function controllerSections(
  cwd: string,
): Promise<{ classes: PlanAppNames; actions: PlanAppNames; scan: ControllerMethodScan | PlanAppUnreadable }> {
  let scan: ControllerMethodScan
  try {
    scan = await parseControllerMethods(cwd)
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
  return { classes: [...scan.classFiles.keys()], actions: [...scan.methods.keys()], scan }
}

interface RouteSection {
  routes: ContextRoute[] | PlanAppUnreadable
  /** The entry that was loaded, app-relative; `undefined` when the app has none. */
  file: string | undefined
  /** One entry per route, in order: the module that declared it, or `null` for the entry registrar. */
  provenance: Array<string | null>
  moduleWarnings: string[]
}

async function routeSection(cwd: string, routesFile: string | undefined): Promise<RouteSection> {
  const target = await resolveRoutesFile(cwd, routesFile)
  const section: RouteSection = { routes: [], file: undefined, provenance: [], moduleWarnings: [] }
  if (target.silentlyAbsent) return section

  try {
    const definitions = await loadRouteDefinitions(resolve(cwd, target.path), cwd, section.moduleWarnings, section.provenance)
    return { ...section, file: target.path, routes: definitions.map(routeDefinitionToContextRoute) }
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
    columns: table.columns.map((column) => column.name),
  }))
}
