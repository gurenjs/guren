import { resolve } from 'node:path'
import type { RouteDefinition } from '@guren/server'

import { graphId, type GraphNode } from './application-graph'
import { routeDefinitionToContextRoute, type ContextRoute } from './context-route'
import { loadRouteDefinitions, resolveRoutesFile } from './load-routes'

export interface RouteGraphSource {
  method: string
  path: string
  name?: string
  module?: string | null
  controller?: { action: string }
}

export interface RouteGraphReading<T extends RouteGraphSource> {
  node: GraphNode & { route: NonNullable<GraphNode['route']> }
  /** Retained by reference: Plan needs live schemas; graph relations need export identities. */
  route: T
}

/** Registration order and duplicate occurrences are identity facts, never sorted or deduplicated here. */
export function readRouteGraph<T extends RouteGraphSource>(
  routes: readonly T[],
  source: 'introspection' | 'routes-file',
): RouteGraphReading<T>[] {
  const occurrences = new Map<string, number>()
  return routes.map((route, order) => {
    const module = route.module ?? null
    const identity = graphId(module, route.method, route.path, route.name ?? null)
    const occurrence = occurrences.get(identity) ?? 0
    occurrences.set(identity, occurrence + 1)
    return { route, node: {
      id: graphId('route', module, route.method, route.path, route.name ?? null, occurrence),
      kind: 'route', label: route.name ?? `${route.method} ${route.path}`, module,
      route: { method: route.method, path: route.path, ...(route.name ? { name: route.name } : {}),
        ...(route.controller ? { action: route.controller.action } : {}), order },
      evidence: [{ kind: 'registered', source }],
    } }
  })
}

export interface RoutesFileGraphReading {
  routes: ContextRoute[] | { unreadable: string }
  entries: RouteGraphReading<RouteDefinition>[]
  definitions: RouteDefinition[] | undefined
  file: string | undefined
  /** Directory names, distinct from the declared modules in the graph identities. */
  provenance: Array<string | null>
  moduleWarnings: string[]
}

/** Plan's registrar reading; importing an app entry or replacing it with a manifest would change approval facts. */
export async function readRoutesFileGraph(cwd: string, routesFile?: string): Promise<RoutesFileGraphReading> {
  const target = await resolveRoutesFile(cwd, routesFile)
  const reading: RoutesFileGraphReading = { routes: [], entries: [], definitions: undefined, file: undefined, provenance: [], moduleWarnings: [] }
  if (target.silentlyAbsent) return reading
  try {
    const definitions = await loadRouteDefinitions(resolve(cwd, target.path), cwd, reading.moduleWarnings, reading.provenance)
    const entries = readRouteGraph(definitions, 'routes-file')
    return { ...reading, file: target.path, definitions, entries, routes: entries.map(({ route }) => routeDefinitionToContextRoute(route)) }
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)) || 'the routes file threw without a message'
    return { ...reading, file: target.path, routes: { unreadable: reason } }
  }
}
