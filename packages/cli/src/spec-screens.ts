import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { ClassDeclaration } from '@babel/types'
import { discoverControllerFiles, classNameFromPath, toPosixRelative, fileExists } from './discovery'
import {
  routeDefinitionToContextRoute,
  escapeMarkdownTableCell,
  type ContextRoute,
} from './context-route'
import { loadRouteDefinitions, DEFAULT_ROUTES_FILE } from './load-routes'
import { extractClassDeclaration } from './model-parser'
import { parseSourceFile } from './parse-cache'
import {
  extractInertiaPageRefs,
  describeInertiaPage,
  listInertiaPageIds,
  type InertiaPageDescription,
} from './inertia-pages'
import { SPEC_BANNER, compareStrings, type SpecArtifact } from './spec-artifact'

const PAGES_DIR = 'resources/js/pages'

interface Screen extends InertiaPageDescription {
  /** Rendered `METHOD /path → Controller.action` entries, sorted. */
  routes: string[]
}

/**
 * Where a controller file's `this.inertia(...)` references live: attributed
 * to the action whose body contains them, plus the leftovers that sit
 * outside any action (a helper function, a class field initializer).
 */
interface ControllerPageRefs {
  /** Action name → page IDs referenced in that action's body. */
  byAction: Map<string, Set<string>>
  /** Page IDs referenced in the file but not inside any action body. */
  outsideActions: Set<string>
}

/**
 * The controller class in a source file. An exported class wins over an
 * unexported helper declared alongside it; a bare class is only used when
 * nothing is exported.
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
 * Page references split per action, by slicing the source to each method's
 * span and re-running the shared extractor over the slice. That per-action
 * attribution is what lets a page join to the routes of the single action
 * that renders it rather than to every route on the controller.
 */
function collectControllerPageRefs(source: string, filePath: string): ControllerPageRefs {
  const byAction = new Map<string, Set<string>>()
  const attributed = new Set<string>()

  const classDecl = findControllerClass(source, filePath)
  for (const member of classDecl?.body.body ?? []) {
    if (member.type !== 'ClassMethod') continue
    if (member.key.type !== 'Identifier') continue
    if (member.start === null || member.end === null) continue

    const ids = extractInertiaPageRefs(source.slice(member.start, member.end)).map((ref) => ref.id)
    if (ids.length === 0) continue

    const bucket = byAction.get(member.key.name) ?? new Set<string>()
    for (const id of ids) {
      bucket.add(id)
      attributed.add(id)
    }
    byAction.set(member.key.name, bucket)
  }

  // Everything the file references, minus what an action claimed — an
  // unparsable controller lands entirely here, so its pages still appear.
  const outsideActions = new Set(
    extractInertiaPageRefs(source)
      .map((ref) => ref.id)
      .filter((id) => !attributed.has(id)),
  )

  return { byAction, outsideActions }
}

/**
 * Page references keyed by controller class name — which is what a route's
 * `controller.name` carries, so it is the join key between a page and the
 * routes that render it.
 */
async function collectPagesByController(cwd: string): Promise<Map<string, ControllerPageRefs>> {
  const files = await discoverControllerFiles(cwd)
  const entries = await Promise.all(
    files.map(async (file) => {
      const source = await readFile(file, 'utf-8')
      return [classNameFromPath(file), collectControllerPageRefs(source, file)] as const
    }),
  )

  // A class name can appear in more than one location (app root plus a
  // module); merge rather than letting one shadow the other.
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
 * The route graph, distinguishing the two ways it can come back empty. An
 * app with no routes file at all is a legitimate shape (mid-scaffold, or a
 * pages-only project) and gets a real page-only document. An import that
 * throws is not: the resulting document would look identical to one for an
 * app that genuinely has no routes, so it is flagged degraded and must
 * never be written or byte-compared.
 */
async function loadRouteGraph(cwd: string, relRoutesFile: string): Promise<RouteGraph> {
  if (!(await fileExists(cwd, relRoutesFile))) return { routes: [] }

  try {
    const definitions = await loadRouteDefinitions(resolve(cwd, relRoutesFile), cwd)
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
 * The screen inventory: every Inertia page a controller renders, the Props
 * type its component declares, and the routes that reach it.
 *
 * Pages referenced by a controller are the routed inventory; pages that exist
 * on disk but no controller references are listed separately, so the view
 * covers the whole `resources/js/pages` tree rather than only what happens to
 * be wired up. That split is deliberately page-side ("does any controller
 * reference it") rather than route-side ("did a route match") — when the
 * routes file is absent, a routed page keeps its row with an empty Routes
 * cell instead of being misfiled as unrouted.
 */
export async function generateScreensSpec(cwd: string, routesFile?: string): Promise<SpecArtifact> {
  // Rendered into the document, so it has to be app-root-relative and POSIX —
  // an absolute path would differ per machine and break the drift gate.
  const relRoutesFile = toPosixRelative(cwd, resolve(cwd, routesFile ?? DEFAULT_ROUTES_FILE))

  const [graph, pagesByController, pageIdsOnDisk] = await Promise.all([
    loadRouteGraph(cwd, relRoutesFile),
    collectPagesByController(cwd),
    listInertiaPageIds(cwd),
  ])

  // Row set first: every page any controller references, whether or not a
  // route reaches it. Routes are then layered on per action, so a page whose
  // action has no route keeps its row with an empty Routes cell.
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

  const lines: string[] = [SPEC_BANNER, '', '# Screens', '']
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
