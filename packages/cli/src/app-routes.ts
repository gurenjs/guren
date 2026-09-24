/**
 * The app's routes as introspection registered them (RFC 0026 §5, Part 2d), for consumers that
 * render Zod: the manifest decides which routes exist and in which order, and a route the routes
 * file's registration also produced keeps that definition, whose schemas are live Zod. The
 * manifest carries JSON Schema only (Decision 5), so a route registered elsewhere (a provider's,
 * a plugin's) reaches a renderer without schemas.
 */
import type { AppManifest, RouteDefinition, RouteEntry } from '@guren/server'

import { introspectedRoutes, introspectionUnavailableMessage, type IntrospectionFailed, type IntrospectSource } from './manifest-section'

type JoinableRoute = Pick<RouteDefinition, 'method' | 'path' | 'name'> & { controller?: { name: string; action: string } }

/** Method, path, name and controller action: method and path alone repeat (the prototype ambiguity rule exists for that). */
function routeJoinKey(route: JoinableRoute): string {
  const controller = route.controller ? `${route.controller.name}.${route.controller.action}` : null
  return JSON.stringify([route.method.toUpperCase(), route.path, route.name ?? null, controller])
}

/**
 * The routes file's definition of each manifest entry, index-aligned with `entries`. The nth entry
 * of a key takes the nth definition of it; a key the two sides count differently matches nothing,
 * since pairing them would guess.
 */
export function joinRouteDefinitions<T extends JoinableRoute>(
  entries: readonly JoinableRoute[],
  definitions: readonly T[],
): Array<T | undefined> {
  const byKey = new Map<string, T[]>()
  for (const definition of definitions) {
    const key = routeJoinKey(definition)
    const group = byKey.get(key)
    if (group) group.push(definition)
    else byKey.set(key, [definition])
  }
  const keys = entries.map(routeJoinKey)
  const entryCounts = new Map<string, number>()
  for (const key of keys) entryCounts.set(key, (entryCounts.get(key) ?? 0) + 1)

  const taken = new Map<string, number>()
  return keys.map((key) => {
    const candidates = byKey.get(key)
    if (!candidates || candidates.length !== entryCounts.get(key)) return undefined
    const index = taken.get(key) ?? 0
    taken.set(key, index + 1)
    return candidates[index]
  })
}

/** The alias and group names a manifest route's chain names, as a registered definition's `middlewareNames`. */
export function manifestMiddlewareNames(entry: Pick<RouteEntry, 'middleware'>): string[] {
  return entry.middleware.flatMap((item) => (item.kind !== 'inline' && item.name ? [item.name] : []))
}

/** The route an agent tool was derived from, as codegen pairs a manifest tool with a definition. */
export function agentToolRouteKey(method: string, path: string, routeName: string | undefined): string {
  return `${method.toUpperCase()} ${path} ${routeName ?? ''}`
}

/** A manifest entry in a registered definition's shape, with no schemas: nothing in the manifest is Zod. */
function definitionFromEntry(entry: RouteEntry): RouteDefinition {
  const { module, controller, middleware, schemas, ...rest } = entry
  return {
    ...rest,
    ...(controller ? { controller: { name: controller.name, action: controller.action } } : {}),
    middlewareNames: manifestMiddlewareNames(entry),
  }
}

export type IntrospectedRouteSource =
  | { evidence: 'manifest'; manifest: AppManifest; unmatched: RouteEntry[] }
  | { evidence: 'static'; reason?: string; failure?: IntrospectionFailed }

export interface IntrospectedRouteDefinitions {
  definitions: RouteDefinition[]
  source: IntrospectedRouteSource
}

/**
 * The introspected app's routes, each as the routes file registered it where the join finds one
 * (see {@link joinRouteDefinitions}) and from the manifest without schemas where it does not
 * (`unmatched`). A failed or unusable introspection gives the routes file's definitions. The
 * routes file is loaded on either path, since its Zod is what the callers render, and its load
 * error propagates on both.
 */
export async function loadIntrospectedRouteDefinitions(
  introspect: IntrospectSource | undefined,
  loadStatic: () => Promise<RouteDefinition[]>,
): Promise<IntrospectedRouteDefinitions> {
  const [introspected, definitions] = await Promise.all([introspectedRoutes(introspect), loadStatic()])
  if (introspected.status === 'static') {
    return { definitions, source: { evidence: 'static', reason: introspected.reason, failure: introspected.failure } }
  }

  const { manifest } = introspected
  const joined = joinRouteDefinitions(manifest.routes, definitions)
  const unmatched = manifest.routes.filter((_, index) => !joined[index])
  return {
    definitions: manifest.routes.map((entry, index) => joined[index] ?? definitionFromEntry(entry)),
    source: { evidence: 'manifest', manifest, unmatched },
  }
}

/** Why the routes file stood in for the introspected app, then what the command did instead. */
export function routesFileFallbackMessage(source: Extract<IntrospectedRouteSource, { evidence: 'static' }>, instead: string): string {
  return source.failure
    ? introspectionUnavailableMessage(source.failure, instead)
    : `The app was not introspected: ${source.reason ?? 'the introspection was not usable'}. ${instead}`
}
