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

import { resolve } from 'node:path'
import { isDefinitelyAbsent, listAppRoots } from '../discovery'
import { generateContext } from '../context'
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
  /** Model property names, as `schema-parser.ts` reads them. */
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
  controllers: PlanAppNames
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

export function isUnreadable(section: PlanAppNames | PlanAppState['routes'] | PlanAppState['tables']): section is PlanAppUnreadable {
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

  let context: Awaited<ReturnType<typeof generateContext>> | undefined
  let contextError: string | undefined
  try {
    context = await generateContext({ cwd: root, routesFile: options.routesFile })
  } catch (error) {
    contextError = error instanceof Error ? error.message : String(error)
  }

  const names = (values: string[] | undefined): PlanAppNames =>
    values ?? { unreadable: contextError ?? 'the project context could not be read' }

  return {
    models: context ? context.models.map((model) => model.className) : names(undefined),
    controllers: names(context?.controllers),
    resources: names(context?.resources),
    policies: names(context?.policies),
    pages: names(context?.pages),
    validators: { unreadable: VALIDATOR_SECTION_REASON },
    routes: routeSection(context, contextError),
    tables: await tableSection(root),
    apiOnly,
  }
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
 * so a schema file that is present and yielded nothing reads as unreadable. A fresh
 * scaffold with an empty schema lands there too, which costs a skipped check rather
 * than a wrong verdict.
 */
async function tableSection(cwd: string): Promise<PlanAppState['tables']> {
  let roots: Awaited<ReturnType<typeof listAppRoots>>
  let tables: PlanAppTable[]
  try {
    roots = await listAppRoots(cwd)
    tables = (await parseSchemaTables(cwd)).map((table) => ({
      identifier: table.identifier,
      tableName: table.tableName,
      columns: table.columns.map((column) => column.name),
    }))
  } catch (error) {
    return { unreadable: error instanceof Error ? error.message : String(error) }
  }

  if (tables.length > 0) return tables

  const present = await Promise.all(
    roots.map(async (root) => !(await isDefinitelyAbsent(root.dir, 'db/schema.ts'))),
  )
  if (present.includes(true)) {
    return { unreadable: `${schemaPathFor(null)} declared no table this parser could read` }
  }
  return tables
}
