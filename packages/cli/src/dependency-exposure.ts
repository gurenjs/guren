/**
 * Which features an installed package reaches (RFC 0039 §4), pure: the lockfile
 * tree, the app's runtime imports and the Application Graph in, one entry per
 * installed instance out. A package is reached through the files importing it or
 * the direct dependency that brings it in, those files through the graph nodes
 * whose files import them, and the nodes through their relations to routes.
 * `importedBy` means an import exists on that path, not that vulnerable code runs.
 */
import { builtinModules } from 'node:module'
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
  version: string
  installedAs: string[]
  direct: boolean
  /** Per direct dependency: one shortest path from it to this instance, as in `deps:why`. */
  paths: Record<string, string[]>
  placement: Array<{ at: Placement; evidence: 'import' }>
  attribution: Attribution
  /** An @guren package also brings it in, and every route runs through those. */
  viaFramework: boolean
  note?: string
  importedBy: Array<{
    file: string
    line: number
    /** The package name the file imports: the instance itself or the direct dependency bringing it in. */
    imports: string
    /** Per graph node reaching the file: the app files from the node's file to the importing one. */
    nodes: Array<{ node: string; kind: GraphNode['kind']; chain: string[] }>
    /** The entries reaching the file: a client or SSR entry runs on every route that renders a page, a server entry on every route. */
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
/** Bare names that resolve to no installed package by design: Node builtins and Vite's virtual modules. */
const NOT_A_PACKAGE = new Set([...builtinModules, 'bun', '@vite/client', '@vite/env'])
/** `mcp-app` is the setup every MCP App view bundles (RFC 0038), counted on every page route as an upper bound. */
const PAGE_ENTRY = /^resources\/js\/(?:app|ssr|mcp-app)\.[cm]?[jt]sx?$/u
/** `runtime.ts`'s `MAIN_ENTRY_CANDIDATES` under `src/`, and the scaffold's `bin/serve.ts`. */
const SERVER_ENTRY = /^(?:src\/main|bin\/serve)\.[cm]?[jt]s$/u
const BUILD_FILE = /^(?:(?:vite|drizzle|playwright[\w.-]*|vitest)\.config|guren\.arch)\.[cm]?[jt]sx?$/u
/** Run by the guren CLI (`db:seed`, console commands) or only by the Vite dev server, as `scripts/` is, never by a route. */
const UNSERVED_FILE = /^(?:src\/console\.[cm]?[jt]s$|app\/Console\/|db\/seeders\/|resources\/js\/dev-entry\.[cm]?[jt]sx?$)/u
const TEST_DIRECTORY = /(?:^|\/)(?:tests?|e2e)\//u
const TEST_SUFFIX = /\.(?:test|spec|setup)\.[cm]?[jt]sx?$/u

/** Where a file runs, by where it sits; `ssrReach` is every file the SSR entry imports. */
export function placementOf(file: string, ssrReach: ReadonlySet<string>): Placement[] {
  if (TEST_DIRECTORY.test(file) || TEST_SUFFIX.test(file)) return ['test']
  if (BUILD_FILE.test(file) || file.startsWith('scripts/') || UNSERVED_FILE.test(file)) return ['build']
  if (file.startsWith('resources/js/')) return ssrReach.has(file) ? ['client', 'ssr'] : ['client']
  return ['server']
}

/** BFS over app-file imports from `start`: each reached file with the chain that reaches it, never entering `stop`. */
function reach(imports: ImportScan, start: string, stop: ReadonlySet<string> = new Set()): Map<string, string[]> {
  const chains = new Map<string, string[]>([[start, [start]]])
  const queue = [start]
  while (queue.length > 0) {
    const file = queue.shift()!
    for (const next of imports.files.get(file)?.files ?? []) {
      if (chains.has(next) || stop.has(next)) continue
      chains.set(next, [...chains.get(file)!, next])
      queue.push(next)
    }
  }
  return chains
}

function exposedRoute(node: GraphNode | undefined): ExposedRoute | null {
  if (!node?.route) return null
  return {
    node: node.id,
    method: node.route.method,
    path: node.route.path,
    ...(node.route.name ? { name: node.route.name } : {}),
    ...(node.route.authentication ? { authentication: node.route.authentication } : {}),
  }
}

function routesByNode(graph: GurenApplicationGraph): Map<string, ExposedRoute[]> {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]))
  const asRoute = (id: string): ExposedRoute | null => exposedRoute(nodes.get(id))
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

/** Every instance that depends on `instance`, directly or not. */
function ancestorsOf(instance: DependencyInstance, byId: ReadonlyMap<string, DependencyInstance>): DependencyInstance[] {
  const seen = new Set<string>([instance.id])
  const queue = [...instance.dependents]
  const out: DependencyInstance[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    const parent = byId.get(id)
    if (!parent) continue
    out.push(parent)
    queue.push(...parent.dependents)
  }
  return out
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
  const allRoutes = (graph?.nodes ?? []).flatMap((node) => {
    const route = exposedRoute(node)
    return route ? [[node.id, route] as const] : []
  })
  const nodeKind = new Map((graph?.nodes ?? []).map((node) => [node.id, node.kind]))
  const entries = [...imports.files.keys()].filter((file) => PAGE_ENTRY.test(file))
  // The entry loads a page only on the routes rendering it, which the page's own node attributes.
  const pageFiles = new Set((graph?.nodes ?? []).flatMap((node) => node.kind === 'page' && node.file !== undefined ? [node.file] : []))
  // What the server entry reaches at boot (src/app.ts, routes, config, providers, middleware files) runs
  // on every route; its reach stops at a graph node's file, which attributes its own routes.
  const serverEntries = graph === null ? [] : [...imports.files.keys()].filter((file) => SERVER_ENTRY.test(file))
  const nodeFileSet = new Set(nodeFiles.map((node) => node.file!))
  entries.push(...serverEntries)
  const reachByEntry = new Map(entries.map((entry) => [entry, SERVER_ENTRY.test(entry) ? reach(imports, entry, nodeFileSet) : reach(imports, entry, pageFiles)]))
  // An inline middleware is defined in a package or an app file the routes file reaches, which the server
  // entry attributes to every route; one exported from a graph node's file is the limit this accepts.
  const middlewareGapCovered = (key: string, coverage: GraphCoverage): boolean =>
    key === 'usesMiddleware' && serverEntries.length > 0 && coverage.reasons.every((reason) => reason.code === 'inline-middleware')
  const pageRoutes = new Map((graph?.nodes ?? [])
    .filter((node) => node.kind === 'page')
    .flatMap((node) => (routes.get(node.id) ?? []).map((route) => [route.node, route] as const)))

  const installed = new Set(tree.packages.flatMap((instance) => [instance.name, ...instance.installedAs]))
  const importReasons: GraphCoverage['reasons'] = [...imports.reasons]
  for (const [name, sites] of importers) {
    if (installed.has(name) || NOT_A_PACKAGE.has(name) || name.startsWith('virtual:')) continue
    for (const site of sites) {
      importReasons.push({ code: 'not-installed', message: `${site.file}:${site.line} imports ${name}, which no installed package or app file answers (an alias this reader does not resolve?).`, file: site.file })
    }
  }

  // A served file no graph node and no entry reaches may run on any route; the graph cannot say which.
  const unowned = new Map<string, GraphCoverage['reasons'][number]>()

  // Whether an import exists rests on the tree and the scan; which route it reaches rests on the graph too.
  const importsComplete = tree.coverage.status === 'complete' && importReasons.length === 0
  const graphComplete = graph !== null && Object.entries(graph.coverage).every(([key, coverage]) => coverage.status === 'complete' || middlewareGapCovered(key, coverage))

  const byId = new Map(tree.packages.map((instance) => [instance.id, instance]))
  const packages = tree.packages.map((instance): ExposedPackage => {
    // Importing any package that depends on this one may run it; importing a @guren package is how the app reaches the framework.
    const ancestors = ancestorsOf(instance, byId)
    const names = [...new Set([
      ...instance.installedAs,
      ...[...headsOf(instance), ...ancestors.flatMap((ancestor) => ancestor.installedAs)].filter((name) => !isFramework(name)),
    ])]
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
      for (const entry of site.entries) {
        for (const [id, route] of SERVER_ENTRY.test(entry) ? allRoutes : pageRoutes) reached.set(id, route)
      }
    }
    const placements = new Set(importedBy.flatMap((site) => placementOf(site.file, ssrReach)))
    // A test or build file is never served, so no route can reach a package only those import.
    const served = (file: string) => placementOf(file, ssrReach).some((at) => at !== 'test' && at !== 'build')
    const servedImport = importedBy.some((site) => served(site.file))
    let unattributed = false
    for (const site of importedBy) {
      // A test node reaches a file without serving it, so it owns nothing.
      if (!served(site.file) || site.nodes.some((owner) => owner.kind !== 'test') || site.entries.length > 0) continue
      unattributed = true
      unowned.set(site.file, { code: 'unowned-file', message: `${site.file} is served but no graph node or entry reaches it, so the routes running it are unknown.`, file: site.file })
    }
    const placement = [...placements].sort().map((at) => ({ at, evidence: 'import' as const }))
    const viaFramework = [...headsOf(instance), ...ancestors.map((ancestor) => ancestor.name)].some(isFramework)
    const attribution: Attribution = reached.size > 0 ? 'routes'
      : viaFramework ? 'framework'
      : importsComplete && !unattributed && (!servedImport || graphComplete) ? 'none-found'
      : 'unknown'
    return {
      id: instance.id,
      name: instance.name,
      version: instance.version,
      installedAs: instance.installedAs,
      direct: instance.direct,
      paths: instance.paths,
      placement,
      attribution,
      viaFramework,
      ...(viaFramework ? { note: attribution === 'framework' ? 'Brought in by @guren packages, which every route runs through.' : 'Also brought in by @guren packages, which every route runs through.' } : {}),
      importedBy,
      routes: [...reached.values()].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method)),
    }
  })

  return {
    coverage: {
      tree: tree.coverage,
      imports: { status: importReasons.length === 0 ? 'complete' : 'partial', reasons: importReasons },
      placement: { status: 'complete', reasons: [] },
      graph: graph === null
        ? { status: 'unavailable', reasons: [{ code: 'no-graph', message: 'The Application Graph could not be collected, so no route is attributed.' }] }
        : {
            status: graphComplete && unowned.size === 0 ? 'complete' : 'partial',
            reasons: [
              ...Object.entries(graph.coverage).flatMap(([key, coverage]) => coverage.status === 'complete' || middlewareGapCovered(key, coverage) ? [] : coverage.reasons.map((reason) => ({ ...reason, message: `${key}: ${reason.message}` }))),
              ...[...unowned.values()].sort((a, b) => a.message.localeCompare(b.message)),
            ],
          },
      runtime: { status: 'unavailable', reasons: [{ code: 'not-checked', message: 'The Bun runtime is checked by loadDependencyExposure, not by the join.' }] },
    },
    packages,
  }
}
