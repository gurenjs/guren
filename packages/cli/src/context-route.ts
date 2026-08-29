import { resolve } from 'node:path'
import type { AgentRouteMetadata, RouteDefinition } from '@guren/core'
import { loadRouteDefinitions, resolveRoutesFile } from './load-routes'
import { schemaToTypeString } from './schema-type-extractor'

/**
 * What a route's middleware chain authorizes, derived once here from the
 * stamped `capabilities.authorization` (RFC 0007) so every consumer reads the
 * same answer.
 *
 * Derived rather than carried raw: the capability shape is internal to
 * `@guren/server` and documented as changeable, while `guren context --json`
 * is an output contract. The derivability rule lives here and nowhere else —
 * a single ability is `abilities.length === 1` with `mode: 'all'` and no
 * method-map resolution. `mode: 'mixed'`, or an `abilityFor` callback
 * (`fromMethodMap: false`), means authorization is enforced but the ability
 * is *not* statically knowable: consumers must say so rather than pick a name
 * out of `abilities`.
 */
export interface ContextRouteAuthorization {
  /** The one ability this route enforces, present only when derivable. */
  ability?: string
  /** Ability names the chain checks, in check order. Empty when every check derives its ability at request time. */
  abilities: string[]
  /** How the checks combine, as stamped. */
  mode: 'all' | 'any' | 'mixed'
  /** True when a check resolves its ability from the request method via the built-in verb map. */
  fromMethodMap?: boolean
}

function routeAuthorization(def: RouteDefinition): ContextRouteAuthorization | undefined {
  const authorization = def.capabilities?.authorization
  if (!authorization) return undefined

  const { abilities, mode, resource } = authorization
  const derivable = abilities.length === 1 && mode === 'all' && !resource

  return {
    ability: derivable ? abilities[0] : undefined,
    abilities: [...abilities],
    mode,
    ...(resource ? { fromMethodMap: resource.fromMethodMap } : {}),
  }
}

/**
 * Serializable route view shared by the whole-project context and the
 * entity bundle: `RouteDefinition` with its live Zod schema objects
 * replaced by rendered type strings, so `--json` output stays clean.
 */
export interface ContextRoute {
  method: string
  path: string
  name?: string
  controller?: { name: string; action: string }
  bindings?: Record<string, string>
  middleware?: string[]
  hasInlineMiddleware?: boolean
  params?: string
  query?: string
  body?: string
  output?: string
  /**
   * Agent exposure metadata as declared (RFC 0016), verbatim — absence means
   * the route is not an agent tool. Plain data, so it needs none of the
   * schema→string rendering the fields above do.
   */
  agent?: AgentRouteMetadata
  /** What the route's middleware chain authorizes. See {@link ContextRouteAuthorization}. */
  authorization?: ContextRouteAuthorization
  summary?: string
  description?: string
  tags?: string[]
  operationId?: string
  deprecated?: boolean
}

export function routeDefinitionToContextRoute(def: RouteDefinition): ContextRoute {
  return {
    method: def.method.toUpperCase(),
    path: def.path,
    name: def.name,
    controller: def.controller,
    bindings: def.bindings,
    middleware: def.middlewareNames?.length ? def.middlewareNames : undefined,
    hasInlineMiddleware: def.hasInlineMiddleware || undefined,
    // `params` and `query` document what the controller ends up with — a
    // coerced `:id` is more useful read as `number` than as the URL's string.
    // `body` is the one an agent has to *write*, so it renders the wire side.
    params: schemaToTypeString(def.schemas?.params, { io: 'output' }),
    query: schemaToTypeString(def.schemas?.query, { io: 'output' }),
    body: schemaToTypeString(def.schemas?.body, { io: 'input' }),
    output: schemaToTypeString(def.schemas?.output, { io: 'output' }),
    agent: def.agent,
    authorization: routeAuthorization(def),
    summary: def.summary,
    description: def.description,
    tags: def.tags,
    operationId: def.operationId,
    deprecated: def.deprecated,
  }
}

/**
 * A value rendered inside a markdown pipe-table cell — schema type strings
 * routinely contain `|` (unions) and can span lines, both of which break
 * table structure unescaped.
 */
export function escapeMarkdownTableCell(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|')
  if (!escaped.includes('\n')) {
    return escaped
  }
  // Collapse newlines with their surrounding whitespace via split/join —
  // regex forms of this (`\s*\r?\n\s*`) backtrack quadratically.
  return escaped
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
}

/**
 * Every route as a `ContextRoute`, or `[]` when the routes file can't be
 * loaded (missing deps, mid-scaffold app, etc.) — context commands degrade
 * to a route-less view instead of failing.
 *
 * `loadErrors`, when passed, receives the reason the load failed. Pass it
 * unless the caller has nothing to render it into: an app whose routes file
 * throws produces the same empty list as an app with no routes at all, so a
 * caller that drops the reason publishes a confident-looking "no routes"
 * that nobody can tell apart from a real one — the defect this degradation
 * had for as long as it swallowed the error outright.
 *
 * When there is nothing to load and that is a legitimate shape rather than a
 * failure, the empty list carries no reason — see `resolveRoutesFile()`.
 */
export async function loadContextRoutes(
  cwd: string,
  routesFile?: string,
  loadErrors?: string[],
): Promise<ContextRoute[]> {
  const target = await resolveRoutesFile(cwd, routesFile)
  if (target.silentlyAbsent) return []

  try {
    const definitions = await loadRouteDefinitions(resolve(cwd, target.path), cwd)
    return definitions.map(routeDefinitionToContextRoute)
  } catch (error) {
    loadErrors?.push(error instanceof Error ? error.message : String(error))
    return []
  }
}
