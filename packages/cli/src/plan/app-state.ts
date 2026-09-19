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
import { isDefinitelyAbsent, listAppRoots, type AppRoot } from '../discovery'
import { generateContext } from '../context'
import { parseControllerMethods } from '../controller-methods'
import { parseSchemaTables, schemaPathFor } from '../schema-parser'
import { isConfirmedApiOnlyApp } from '../app-surface'

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
  /**
   * Model property names as `schema-parser.ts` reads them, which is a **lower
   * bound**: spread columns (`...timestamps`) go unreported. A name absent here
   * is therefore unconfirmed, never proof the column does not exist.
   */
  columns: string[]
}

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
}

export function isUnreadable(
  section: PlanAppNames | PlanAppState['routes'] | PlanAppState['tables'],
): section is PlanAppUnreadable {
  return !Array.isArray(section)
}

const VALIDATOR_SECTION_REASON =
  'a plan names a validator by its exported schema symbol, which no scanner resolves from a file name'

/**
 * Builds {@link PlanAppState} from a project directory. The only filesystem-facing
 * half of the checks; everything else takes the state as an argument.
 */
export async function loadPlanAppState(cwd: string, options: { routesFile?: string } = {}): Promise<PlanAppState> {
  const root = resolve(cwd)
  const apiOnly = await isConfirmedApiOnlyApp(root).catch(() => false)
  const roots = await listAppRoots(root).catch((): AppRoot[] => [])

  let context: Awaited<ReturnType<typeof generateContext>> | undefined
  let contextError: string | undefined
  try {
    context = await generateContext({ cwd: root, routesFile: options.routesFile })
  } catch (error) {
    contextError = error instanceof Error ? error.message : String(error)
  }

  const [modelsDir, resourcesDir, policiesDir, pagesDir] = await Promise.all([
    probeDirectory(roots, 'app/Models'),
    probeDirectory(roots, 'app/Http/Resources'),
    probeDirectory(roots, 'app/Policies'),
    probeDirectory([{ dir: root, module: null }], 'resources/js/pages'),
  ])

  const section = (values: string[] | undefined, probe: string | undefined): PlanAppNames => {
    if (!values) return { unreadable: contextError ?? 'the project context could not be read' }
    return probe ? { unreadable: probe } : values
  }

  const controllers = await controllerSections(root)

  return {
    models: section(context?.models.map((model) => model.className), modelsDir),
    controllers: controllers.classes,
    actions: controllers.actions,
    resources: section(context?.resources, resourcesDir),
    policies: section(context?.policies, policiesDir),
    pages: section(context?.pages, pagesDir),
    validators: { unreadable: VALIDATOR_SECTION_REASON },
    routes: routeSection(context, contextError),
    tables: await tableSection(root, roots),
    apiOnly,
  }
}

/**
 * The reason a section's directory would not open, for the discoverers that answer
 * `[]` either way. Only the directory itself is probed, not the tree beneath it: an
 * unreadable nested directory still under-reports, which no cheap probe catches.
 */
async function probeDirectory(roots: ReadonlyArray<AppRoot>, relativeDir: string): Promise<string | undefined> {
  for (const root of roots) {
    if (await isDefinitelyAbsent(root.dir, relativeDir)) continue
    try {
      await readdir(resolve(root.dir, relativeDir))
    } catch (error) {
      return `${relativeDir} would not open (${error instanceof Error ? error.message : String(error)})`
    }
  }
  return undefined
}

/**
 * Controller classes and their actions from the one controller scan, which reports
 * the files it could not read. A partial scan makes both sections unreadable: a
 * class missing because its file did not parse is indistinguishable from one the
 * app does not have.
 */
async function controllerSections(cwd: string): Promise<{ classes: PlanAppNames; actions: PlanAppNames }> {
  let scan: Awaited<ReturnType<typeof parseControllerMethods>>
  try {
    scan = await parseControllerMethods(cwd)
  } catch (error) {
    const unreadable = { unreadable: error instanceof Error ? error.message : String(error) }
    return { classes: unreadable, actions: unreadable }
  }

  const skipped = [...scan.unreadableFiles, ...scan.unparsedFiles]
  if (skipped.length > 0) {
    const unreadable = { unreadable: `${skipped.length} controller file(s) did not parse: ${skipped.join(', ')}` }
    return { classes: unreadable, actions: unreadable }
  }
  return { classes: [...scan.classFiles.keys()], actions: [...scan.methods.keys()] }
}

function routeSection(
  context: Awaited<ReturnType<typeof generateContext>> | undefined,
  contextError: string | undefined,
): PlanAppState['routes'] {
  if (!context) return { unreadable: contextError ?? 'the project context could not be read' }
  if (context.routesError) return { unreadable: context.routesError }
  return context.routes.map((route) => ({ name: route.name, method: route.method, path: route.path }))
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
    const path = schemaPathFor(root.module)
    if (await isDefinitelyAbsent(root.dir, 'db/schema.ts')) continue
    if (parsed.some((table) => table.module === root.module)) continue
    return { unreadable: `${path} declared no table this parser could read` }
  }

  return parsed.map((table) => ({
    identifier: table.identifier,
    tableName: table.tableName,
    columns: table.columns.map((column) => column.name),
  }))
}
