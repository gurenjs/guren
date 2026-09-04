import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { ClassDeclaration } from '@babel/types'
import { discoverControllerFiles, classNameFromPath, toPosixRelative } from './discovery'
import {
  routeDefinitionToContextRoute,
  escapeMarkdownTableCell,
  type ContextRoute,
} from './context-route'
import { loadRouteDefinitions, resolveRoutesFile, type RoutesFileTarget } from './load-routes'
import { classActionMembers } from './controller-methods'
import { extractClassDeclaration } from './model-parser'
import { parseSourceFile } from './parse-cache'
import {
  extractInertiaPageRefs,
  describeInertiaPage,
  listInertiaPageIds,
  type InertiaPageDescription,
} from './inertia-pages'
import { specHeader, compareStrings, type SpecArtifact } from './spec-artifact'

const PAGES_DIR = 'resources/js/pages'

interface Screen extends InertiaPageDescription {
  /** Rendered `METHOD /path → Controller.action` entries, sorted. */
  routes: string[]
}

/**
 * Where a controller file's `this.inertia(...)` references live: attributed to the action
 * whose body contains them, plus the leftovers that sit outside any action.
 */
interface ControllerPageRefs {
  /** Action name → page IDs referenced in that action's body. */
  byAction: Map<string, Set<string>>
  /** Page IDs referenced in the file but not inside any action body. */
  outsideActions: Set<string>
}

/**
 * The controller class in a source file. An exported class wins over an unexported helper
 * declared alongside it.
 */
function findControllerClass(source: string, filePath: string): ClassDeclaration | null {
  const ast = parseSourceFile(source, filePath)
  if (!ast) return null

  let unexported: ClassDeclaration | null = null
  for (const node of ast.program.body) {
    const classDecl = extractClassDeclaration(node)
    if (!classDecl) continue
    if (node.type !== 'ClassDeclaration') return classDecl
    unexported ??= classDecl
  }
  return unexported
}

/**
 * Page references split per action, by slicing the source to each member's span. That
 * attribution is what joins a page to the routes of the one action that renders it,
 * rather than to every route on the controller.
 */
function collectControllerPageRefs(source: string, filePath: string): ControllerPageRefs {
  const byAction = new Map<string, Set<string>>()
  const attributed = new Set<string>()

  const classDecl = findControllerClass(source, filePath)
  // Field actions (`show = () => this.inertia(...)`) are attributed like methods —
  // `Router` dispatches to both.
  for (const { member, name } of classDecl ? classActionMembers(classDecl) : []) {
    if (member.start === null || member.end === null) continue

    const ids = extractInertiaPageRefs(source.slice(member.start, member.end)).map((ref) => ref.id)
    if (ids.length === 0) continue

    const bucket = byAction.get(name) ?? new Set<string>()
    for (const id of ids) {
      bucket.add(id)
      attributed.add(id)
    }
    byAction.set(name, bucket)
  }

  // Everything the file references minus what an action claimed; an unparsable
  // controller lands entirely here, so its pages still appear.
  const outsideActions = new Set(
    extractInertiaPageRefs(source)
      .map((ref) => ref.id)
      .filter((id) => !attributed.has(id)),
  )

  return { byAction, outsideActions }
}

/** Page references keyed by controller class name — what a route's `controller.name` carries. */
async function collectPagesByController(cwd: string): Promise<Map<string, ControllerPageRefs>> {
  const files = await discoverControllerFiles(cwd)
  const entries = await Promise.all(
    files.map(async (file) => {
      const source = await readFile(file, 'utf-8')
      return [classNameFromPath(file), collectControllerPageRefs(source, file)] as const
    }),
  )

  // A class name can appear in more than one location (app root plus a module).
  const byController = new Map<string, ControllerPageRefs>()
  for (const [className, refs] of entries) {
    const existing = byController.get(className)
    if (!existing) {
      byController.set(className, refs)
      continue
    }
    for (const [action, ids] of refs.byAction) {
      const bucket = existing.byAction.get(action) ?? new Set<string>()
      for (const id of ids) bucket.add(id)
      existing.byAction.set(action, bucket)
    }
    for (const id of refs.outsideActions) existing.outsideActions.add(id)
  }
  return byController
}

interface RouteGraph {
  routes: ContextRoute[]
  /** Set when the routes file exists but importing it threw. */
  degraded?: string
}

/**
 * The route graph, distinguishing the two ways it can come back empty. No routes file at
 * all is a legitimate shape and gets a real page-only document; an import that throws, or
 * a named `--routes` that is not there, is flagged degraded — the resulting document
 * would look identical to a genuinely routeless app and the drift gate would compare it.
 * `resolveRoutesFile()` owns that distinction.
 */
async function loadRouteGraph(cwd: string, target: RoutesFileTarget): Promise<RouteGraph> {
  if (target.silentlyAbsent) return { routes: [] }

  try {
    const definitions = await loadRouteDefinitions(resolve(cwd, target.path), cwd)
    return { routes: definitions.map(routeDefinitionToContextRoute) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { routes: [], degraded: `route graph failed to load: ${message}` }
  }
}

function renderRoute(route: ContextRoute): string {
  const action = route.controller ? ` → ${route.controller.name}.${route.controller.action}` : ''
  return `${route.method} ${route.path}${action}`
}

/**
 * The screen inventory: every Inertia page a controller renders, the Props type its
 * component declares, and the routes that reach it. Pages on disk no controller references
 * are listed separately, so the whole `resources/js/pages` tree is covered. That split is
 * page-side ("does any controller reference it") rather than route-side, so an absent
 * routes file leaves a routed page with an empty Routes cell instead of misfiling it.
 */
export async function generateScreensSpec(cwd: string, routesFile?: string): Promise<SpecArtifact> {
  const target = await resolveRoutesFile(cwd, routesFile)
  // Rendered into the document, so app-root-relative and POSIX: an absolute path would
  // differ per machine and break the drift gate.
  const relRoutesFile = toPosixRelative(cwd, resolve(cwd, target.path))

  const [graph, pagesByController, pageIdsOnDisk] = await Promise.all([
    loadRouteGraph(cwd, target),
    collectPagesByController(cwd),
    listInertiaPageIds(cwd),
  ])

  // Row set first: every page any controller references. Routes are layered on per
  // action, so a page whose action has no route keeps its row with an empty Routes cell.
  const routesByPage = new Map<string, Set<string>>()
  const bucketFor = (id: string): Set<string> => {
    const bucket = routesByPage.get(id) ?? new Set<string>()
    routesByPage.set(id, bucket)
    return bucket
  }

  for (const refs of pagesByController.values()) {
    for (const ids of refs.byAction.values()) {
      for (const id of ids) bucketFor(id)
    }
    for (const id of refs.outsideActions) bucketFor(id)
  }

  for (const route of graph.routes) {
    const controller = route.controller
    if (!controller) continue
    const ids = pagesByController.get(controller.name)?.byAction.get(controller.action)
    if (!ids) continue
    const rendered = renderRoute(route)
    for (const id of ids) bucketFor(id).add(rendered)
  }

  const screens: Screen[] = await Promise.all(
    [...routesByPage]
      .sort(([a], [b]) => compareStrings(a, b))
      .map(async ([id, routes]) => ({
        ...(await describeInertiaPage(cwd, id)),
        routes: [...routes].sort(compareStrings),
      })),
  )

  const unrouted = pageIdsOnDisk.filter((id) => !routesByPage.has(id))

  const lines: string[] = specHeader('Screens', 'Routes, controllers, and the Inertia pages they render.')
  lines.push(
    `Derived from \`${relRoutesFile}\`, controller \`this.inertia(...)\` calls, `
    + `and page components under \`${PAGES_DIR}/\` — those files are the source of truth, not this document.`,
  )
  lines.push('')
  lines.push(
    'Page references are attributed to the controller action whose body makes the call, so a page '
    + 'lists only the routes of the action that renders it. A page referenced outside any action '
    + 'keeps a row with an empty Routes cell.',
  )
  lines.push('')

  lines.push(`## Pages (${screens.length})`)
  lines.push('')
  if (screens.length > 0) {
    lines.push('| Page | Props | Routes |')
    lines.push('|------|-------|--------|')
    for (const screen of screens) {
      const page = screen.filePath ? screen.id : `${screen.id} (component file missing)`
      const cells = [page, screen.props ?? '', screen.routes.join(', ')]
      lines.push(`| ${cells.map(escapeMarkdownTableCell).join(' | ')} |`)
    }
  } else {
    lines.push('No controller renders an Inertia page.')
  }
  lines.push('')

  if (unrouted.length > 0) {
    lines.push(`## Unrouted pages (${unrouted.length})`)
    lines.push('')
    lines.push('Page components on disk that no controller references.')
    lines.push('')
    for (const id of unrouted) {
      lines.push(`- ${id}`)
    }
    lines.push('')
  }

  return {
    fileName: 'screens.md',
    content: `${lines.join('\n').replace(/\n+$/, '')}\n`,
    ...(graph.degraded ? { degraded: graph.degraded } : {}),
  }
}
