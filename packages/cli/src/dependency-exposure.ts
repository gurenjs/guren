/**
 * Which features an installed package reaches (RFC 0039 §4), pure: the lockfile
 * tree, the app's runtime imports and the Application Graph in, one entry per
 * installed instance out. A package is reached through the files importing it or
 * the direct dependency that brings it in, those files through the graph nodes
 * whose files import them, and the nodes through their relations to routes.
 * `importedBy` means an import exists on that path, not that vulnerable code runs.
 */
import type { GraphCoverage, GraphNode, GurenApplicationGraph } from './application-graph'
import type { DependencyInstance, DependencyTree } from './dependency-tree'
import type { ImportScan } from './import-scan'

export type Placement = 'server' | 'client' | 'ssr' | 'build' | 'test'
export type Attribution = 'routes' | 'framework' | 'none-found' | 'unknown'

export interface ExposedRoute {
  node: string
  method: string
  path: string
  name?: string
  authentication?: 'required' | 'guest-only'
}

export interface ExposedPackage {
  id: string
  name: string
  installedAs: string[]
  placement: Array<{ at: Placement; evidence: 'import' }>
  attribution: Attribution
  note?: string
  importedBy: Array<{
    file: string
    line: number
    /** The package name the file imports: the instance itself or the direct dependency bringing it in. */
    imports: string
    /** Per graph node reaching the file: the app files from the node's file to the importing one. */
    nodes: Array<{ node: string; kind: GraphNode['kind']; chain: string[] }>
    /** The client or SSR entries reaching the file, which run on every route that renders a page. */
    entries: string[]
  }>
  routes: ExposedRoute[]
}

export interface ExposureInput {
  tree: DependencyTree
  imports: ImportScan
  graph: GurenApplicationGraph | null
}

export type ExposureCoverageKey = 'tree' | 'imports' | 'placement' | 'graph' | 'runtime'

export interface ExposureJoin {
  coverage: Record<ExposureCoverageKey, GraphCoverage>
  packages: ExposedPackage[]
}

const SSR_ENTRIES = ['resources/js/ssr.tsx', 'resources/js/ssr.ts', 'resources/js/ssr.jsx', 'resources/js/ssr.js']
const PAGE_ENTRY = /^resources\/js\/(?:app|ssr)\.[cm]?[jt]sx?$/u
const BUILD_FILE = /^(?:vite|drizzle|playwright[\w.-]*|vitest)\.config\.[cm]?[jt]sx?$/u
const TEST_DIRECTORY = /(?:^|\/)tests?\//u
const TEST_SUFFIX = /\.(?:test|spec|browser)\.[cm]?[jt]sx?$/u

/** Where a file runs, by where it sits; `ssrReach` is every file the SSR entry imports. */
export function placementOf(file: string, ssrReach: ReadonlySet<string>): Placement[] {
  if (TEST_DIRECTORY.test(file) || TEST_SUFFIX.test(file)) return ['test']
  if (BUILD_FILE.test(file) || file.startsWith('scripts/')) return ['build']
  if (file.startsWith('resources/js/')) return ssrReach.has(file) ? ['client', 'ssr'] : ['client']
  return ['server']
}

/** BFS over app-file imports from `start`: each reached file with the chain that reaches it. */
function reach(imports: ImportScan, start: string): Map<string, string[]> {
  const chains = new Map<string, string[]>([[start, [start]]])
  const queue = [start]
  while (queue.length > 0) {
    const file = queue.shift()!
    for (const next of imports.files.get(file)?.files ?? []) {
      if (chains.has(next)) continue
      chains.set(next, [...chains.get(file)!, next])
      queue.push(next)
    }
  }
  return chains
}

function routesByNode(graph: GurenApplicationGraph): Map<string, ExposedRoute[]> {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]))
  const asRoute = (id: string): ExposedRoute | null => {
    const node = nodes.get(id)
    if (!node?.route) return null
    return {
      node: id,
      method: node.route.method,
      path: node.route.path,
      ...(node.route.name ? { name: node.route.name } : {}),
      ...(node.route.authentication ? { authentication: node.route.authentication } : {}),
    }
  }
  const out = new Map<string, Map<string, ExposedRoute>>()
  const add = (node: string, routeId: string) => {
    const route = asRoute(routeId)
    if (!route) return
    const entry = out.get(node) ?? new Map<string, ExposedRoute>()
    entry.set(routeId, route)
    out.set(node, entry)
  }
  const handlersOf = new Map<string, string[]>()
  for (const edge of graph.edges) {
    if (edge.relation === 'handles') handlersOf.set(edge.to, [...(handlersOf.get(edge.to) ?? []), edge.from])
  }
  for (const edge of graph.edges) {
    switch (edge.relation) {
      case 'handles':
        add(edge.to, edge.from)
        break
      case 'binds':
      case 'usesMiddleware':
        add(edge.to, edge.from)
        break
      case 'validates':
      case 'authorizes':
      case 'renders': {
        if (nodes.get(edge.from)?.kind === 'route') {
          add(edge.to, edge.from)
          break
        }
        // From a controller: only the routes to the action the evidence names, when it names one.
        const actions = edge.evidence.flatMap((evidence) => evidence.source.startsWith('controller:') ? [evidence.source.slice('controller:'.length)] : [])
        for (const routeId of handlersOf.get(edge.from) ?? []) {
          const action = nodes.get(routeId)?.route?.action
          if (actions.length === 0 || (action !== undefined && actions.includes(action))) add(edge.to, routeId)
        }
        break
      }
      default:
        break
    }
  }
  return new Map([...out].map(([node, routes]) => [node, [...routes.values()]]))
}

function isFramework(name: string): boolean {
  return name.startsWith('@guren/')
}

function headsOf(instance: DependencyInstance): string[] {
  return Object.keys(instance.paths)
}

export function joinExposure(input: ExposureInput): ExposureJoin {
  const { tree, imports, graph } = input
  const ssrEntry = SSR_ENTRIES.find((file) => imports.files.has(file))
  const ssrReach = new Set(ssrEntry ? reach(imports, ssrEntry).keys() : [])

  const importers = new Map<string, Array<{ file: string; line: number }>>()
  for (const [file, scanned] of imports.files) {
    for (const entry of scanned.packages) {
      importers.set(entry.name, [...(importers.get(entry.name) ?? []), { file, line: entry.line }])
    }
  }

  const nodeFiles = (graph?.nodes ?? []).filter((node) => node.file !== undefined)
  const reachByNode = new Map(nodeFiles.map((node) => [node.id, reach(imports, node.file!)]))
  const routes = graph ? routesByNode(graph) : new Map<string, ExposedRoute[]>()
  const nodeKind = new Map((graph?.nodes ?? []).map((node) => [node.id, node.kind]))
  const entries = [...imports.files.keys()].filter((file) => PAGE_ENTRY.test(file))
  const reachByEntry = new Map(entries.map((entry) => [entry, reach(imports, entry)]))
  const pageRoutes = new Map((graph?.nodes ?? [])
    .filter((node) => node.kind === 'page')
    .flatMap((node) => (routes.get(node.id) ?? []).map((route) => [route.node, route] as const)))

  // Whether an import exists rests on the tree and the scan; which route it reaches rests on the graph too.
  const importsComplete = tree.coverage.status === 'complete' && imports.reasons.length === 0
  const graphComplete = graph !== null && Object.values(graph.coverage).every((coverage) => coverage.status === 'complete')

  const packages = tree.packages.map((instance): ExposedPackage => {
    // An import of a @guren package is how the app reaches the framework, not this package.
    const names = [...new Set([...instance.installedAs, ...headsOf(instance).filter((head) => !isFramework(head))])]
    const importedBy = names.flatMap((name) => (importers.get(name) ?? []).map((site) => ({
      file: site.file,
      line: site.line,
      imports: name,
      nodes: nodeFiles.flatMap((node) => {
        const chain = reachByNode.get(node.id)!.get(site.file)
        return chain ? [{ node: node.id, kind: nodeKind.get(node.id)!, chain }] : []
      }),
      entries: entries.filter((entry) => reachByEntry.get(entry)!.has(site.file)),
    })))
    const reached = new Map<string, ExposedRoute>()
    for (const site of importedBy) {
      for (const { node } of site.nodes) {
        for (const route of routes.get(node) ?? []) reached.set(route.node, route)
      }
      if (site.entries.length > 0) for (const [id, route] of pageRoutes) reached.set(id, route)
    }
    const placements = new Set(importedBy.flatMap((site) => placementOf(site.file, ssrReach)))
    // A test or build file is never served, so no route can reach a package only those import.
    const servedImport = [...placements].some((at) => at !== 'test' && at !== 'build')
    const placement = [...placements].sort().map((at) => ({ at, evidence: 'import' as const }))
    const viaFramework = importedBy.length === 0 && headsOf(instance).length > 0 && headsOf(instance).every(isFramework)
    const attribution: Attribution = reached.size > 0 ? 'routes'
      : viaFramework ? 'framework'
      : importsComplete && (!servedImport || graphComplete) ? 'none-found'
      : 'unknown'
    return {
      id: instance.id,
      name: instance.name,
      installedAs: instance.installedAs,
      placement,
      attribution,
      ...(attribution === 'framework' ? { note: 'Brought in only by @guren packages, which every route runs through.' } : {}),
      importedBy,
      routes: [...reached.values()].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method)),
    }
  })

  return {
    coverage: {
      tree: tree.coverage,
      imports: { status: imports.reasons.length === 0 ? 'complete' : 'partial', reasons: imports.reasons },
      placement: { status: 'complete', reasons: [] },
      graph: graph === null
        ? { status: 'unavailable', reasons: [{ code: 'no-graph', message: 'The Application Graph could not be collected, so no route is attributed.' }] }
        : {
            status: Object.values(graph.coverage).every((coverage) => coverage.status === 'complete') ? 'complete' : 'partial',
            reasons: Object.entries(graph.coverage).flatMap(([key, coverage]) => coverage.status === 'complete' ? [] : coverage.reasons.map((reason) => ({ ...reason, message: `${key}: ${reason.message}` }))),
          },
      runtime: { status: 'unavailable', reasons: [{ code: 'not-implemented', message: 'The runtime advisory check (RFC 0039 §6) is not implemented yet.' }] },
    },
    packages,
  }
}
