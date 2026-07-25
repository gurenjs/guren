import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { collectFiles, discoverControllerFiles, classNameFromPath, toPosixRelative } from './discovery'
import { loadContextRoutes, escapeMarkdownTableCell, type ContextRoute } from './context-route'
import { DEFAULT_ROUTES_FILE } from './load-routes'
import { extractInertiaPageRefs, resolveInertiaPageFile } from './inertia-pages'
import { extractPageProps } from './page-props-extractor'
import { SPEC_BANNER, type SpecArtifact } from './spec-generate'

const PAGES_DIR = 'resources/js/pages'
const PAGE_EXTENSIONS = new Set(['.tsx', '.jsx', '.ts', '.js'])

interface Screen {
  /** Page ID relative to the pages directory, e.g. `posts/Index`. */
  id: string
  /** Component file relative to the app root; absent when nothing exists on disk. */
  filePath?: string
  props?: string
  /** Rendered `METHOD /path → Controller.action` entries, sorted. */
  routes: string[]
}

/** Page IDs for every component file under `resources/js/pages`, sorted. */
async function collectPageIdsOnDisk(cwd: string): Promise<string[]> {
  const pagesDir = resolve(cwd, PAGES_DIR)
  const files = await collectFiles(pagesDir, PAGE_EXTENSIONS)
  return files
    .map((file) => toPosixRelative(pagesDir, file).replace(/\.(tsx|jsx|ts|js)$/, ''))
    // `contracts/` holds shared prop types, not routable pages — the same
    // exclusion the project context map applies.
    .filter((id) => !id.startsWith('contracts'))
    .sort()
}

/**
 * Page IDs each controller class references via `this.inertia(...)`, keyed by
 * the controller's class name (which is what a route's `controller.name`
 * carries — the join key between a page and the routes that render it).
 */
async function collectPagesByController(cwd: string): Promise<Map<string, string[]>> {
  const files = await discoverControllerFiles(cwd)
  const entries = await Promise.all(
    files.map(async (file) => {
      const source = await readFile(file, 'utf-8')
      return [classNameFromPath(file), extractInertiaPageRefs(source).map((ref) => ref.id)] as const
    }),
  )

  // A class name can appear in more than one location (app root plus a
  // module); merge rather than letting one shadow the other.
  const byController = new Map<string, string[]>()
  for (const [className, pageIds] of entries) {
    const merged = new Set([...(byController.get(className) ?? []), ...pageIds])
    byController.set(className, [...merged].sort())
  }
  return byController
}

function renderRoute(route: ContextRoute): string {
  const action = route.controller ? ` → ${route.controller.name}.${route.controller.action}` : ''
  return `${route.method} ${route.path}${action}`
}

async function describeScreen(cwd: string, id: string, routes: string[]): Promise<Screen> {
  const filePath = await resolveInertiaPageFile(cwd, id)
  if (!filePath) return { id, routes }

  let props: string | undefined
  try {
    const extracted = await extractPageProps(resolve(cwd, filePath), id)
    // Props types routinely span lines; collapse whitespace for one-line cells.
    props = extracted.rawType?.replace(/\s+/g, ' ').trim()
  } catch {
    // Unparsable component — still inventory it, just without a Props type.
  }

  return { id, filePath, props, routes }
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
 * routes file can't be loaded, a routed page keeps its row with an empty
 * Routes cell instead of being misfiled as unrouted.
 */
export async function generateScreensSpec(cwd: string, routesFile?: string): Promise<SpecArtifact> {
  const [routes, pagesByController, pageIdsOnDisk] = await Promise.all([
    loadContextRoutes(cwd, routesFile),
    collectPagesByController(cwd),
    collectPageIdsOnDisk(cwd),
  ])

  const routesByController = new Map<string, ContextRoute[]>()
  for (const route of routes) {
    const name = route.controller?.name
    if (!name) continue
    routesByController.set(name, [...(routesByController.get(name) ?? []), route])
  }

  const routesByPage = new Map<string, Set<string>>()
  for (const [controller, pageIds] of pagesByController) {
    const rendered = (routesByController.get(controller) ?? []).map(renderRoute)
    for (const id of pageIds) {
      const bucket = routesByPage.get(id) ?? new Set<string>()
      for (const entry of rendered) bucket.add(entry)
      routesByPage.set(id, bucket)
    }
  }

  const referencedIds = [...routesByPage.keys()].sort()
  const screens = await Promise.all(
    referencedIds.map((id) => describeScreen(cwd, id, [...(routesByPage.get(id) ?? [])].sort())),
  )

  const referenced = new Set(referencedIds)
  const unrouted = pageIdsOnDisk.filter((id) => !referenced.has(id))

  const lines: string[] = [SPEC_BANNER, '', '# Screens', '']
  lines.push(
    `Derived from \`${routesFile ?? DEFAULT_ROUTES_FILE}\`, controller \`this.inertia(...)\` calls, `
    + `and page components under \`${PAGES_DIR}/\` — those files are the source of truth, not this document.`,
  )
  lines.push('')
  lines.push(
    'Page references are resolved per controller file, so a page lists every route on the '
    + 'controller that renders it, not only the single action it belongs to.',
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

  return { fileName: 'screens.md', content: `${lines.join('\n').replace(/\n+$/, '')}\n` }
}
