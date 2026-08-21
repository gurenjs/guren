import { resolve } from 'node:path'
import type { RouteDefinition } from '@guren/core'
import { loadRouteDefinitions, resolveRoutesFile } from './load-routes'
import { schemaToTypeString } from './schema-type-extractor'

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
