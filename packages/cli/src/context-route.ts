import { resolve } from 'node:path'
import type { AgentRouteMetadata, RouteDefinition } from '@guren/core'
import { loadRouteDefinitions, resolveRoutesFile } from './load-routes'
import { schemaToTypeString } from './schema-type-extractor'

/**
 * Optional fields this CLI's `ContextRoute` populates, as a runtime value.
 * `@guren/cli` is resolved from the *app*, so a consumer probes this list to
 * tell "nothing exposed" from "this CLI is too old to answer" — both look like
 * a route list with no `agent`. Append-only: other packages branch on a name here.
 */
export const CONTEXT_ROUTE_FEATURES: readonly string[] = ['agent']

/**
 * What a route's middleware chain authorizes, derived from the stamped
 * `capabilities.authorization` (RFC 0007): that shape is internal to `@guren/server`,
 * while `guren context --json` is a contract. The derivability rule lives only
 * here: `mode: 'mixed'` or an `abilityFor` callback means authorization is enforced
 * but the ability is not statically knowable, so consumers must say so.
 */
export interface ContextRouteAuthorization {
  /** The one ability this route enforces, present only when derivable. */
  ability?: string
  /** Ability names the chain checks, in check order. Empty when every check derives its ability at request time. */
  abilities: string[]
  mode: 'all' | 'any' | 'mixed'
  /** A check resolves its ability from the request method via the built-in verb map. */
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
  /** Agent metadata as declared (RFC 0016); absence means the route is not an agent tool. */
  agent?: AgentRouteMetadata
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
    // `params`/`query` render what the controller ends up with (a coerced `:id`
    // reads as `number`); `body` is written by callers, so it renders the wire side.
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
 * Every route as a `ContextRoute`, or `[]` when the routes file can't be loaded
 * (missing deps, mid-scaffold app) so context commands degrade to a route-less view.
 * Pass `loadErrors` unless there is nowhere to render it: a failed load and an app
 * with no routes produce the same empty list. A legitimately absent routes file
 * carries no reason — see `resolveRoutesFile()`.
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
