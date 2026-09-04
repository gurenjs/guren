import { resolve } from 'node:path'
import type { RouteDefinition } from '@guren/core'
import {
  isZod3Schema,
  objectShape,
  pipeSides,
  typeOf,
  unwrapSingleChild,
  ZOD3_UNSUPPORTED_MESSAGE,
  type ZodSchemaLike,
} from '@guren/core/internal/zod-compat'
import { check, type CheckResult } from './check-result'
import { fileExists } from './discovery'
import { DEFAULT_ROUTES_FILE, loadRouteDefinitions } from './load-routes'
import { extractPathParamNames } from './utils'

export interface RouteContractCheckOptions {
  cwd: string
  /** Routes entry file, POSIX-relative to `cwd`. Defaults to `routes/web.ts`. */
  routesFile?: string
  /** Definitions to check instead of loading them; absent, this loads its own. */
  definitions?: RouteDefinition[]
}

/** A params schema describes what arrives in the URL, never what a parse produces. */
const REQUEST_SIDE = 'input'

/**
 * The `object` node inside a params schema, through every wrapper that does not change
 * which keys exist. Undefined means unreadable (a union of objects, say), not passing:
 * {@link readParamKeys} turns it into a reported skip.
 */
function objectNode(schema: ZodSchemaLike): ZodSchemaLike | undefined {
  if (typeOf(schema) === 'object') {
    return schema
  }

  const nested = unwrapSingleChild(schema, REQUEST_SIDE)
  return nested ? objectNode(nested) : undefined
}

/**
 * Whether a request may leave this key out without the schema rejecting it. Over-reports
 * on purpose: under-reporting files a real 422 as advice. Currently identical to the JSON
 * Schema walker's `isOptional(schema, 'input')` but deliberately kept apart, so a fix
 * aimed at an OpenAPI document cannot silently reclassify a `guren check` finding.
 */
function permitsOmission(schema: ZodSchemaLike): boolean {
  const def = schema._def ?? {}

  switch (typeOf(schema)) {
    case 'optional':
      return true

    // Both fill the value in, so the controller reads something unrelated to the URL.
    case 'default':
    case 'prefault':
    // Swallows any failure, a missing value included.
    case 'catch':
      return true

    // Re-requires a key an inner wrapper made omissible, so the walk stops here.
    case 'nonoptional':
      return false

    // Omissible only if neither stage rejects a missing value. Safe-direction
    // approximation: a transforming stage supplying a value reports as required.
    case 'pipe': {
      const { from, to } = pipeSides(def)
      if (!from) return false
      return to ? permitsOmission(from) && permitsOmission(to) : permitsOmission(from)
    }

    default: {
      const nested = unwrapSingleChild(schema, REQUEST_SIDE)
      return nested ? permitsOmission(nested) : false
    }
  }
}

interface ParamKey {
  name: string
  omissible: boolean
}

type ParamKeysResult =
  | { keys: ParamKey[] }
  | { unreadable: string }

/**
 * The keys a params schema declares, or the reason they could not be read. Never
 * collapses "unreadable" into "no keys", which would read like a route that matched.
 */
function readParamKeys(schema: unknown): ParamKeysResult {
  if (!schema || typeof schema !== 'object') {
    return { unreadable: 'the params option does not hold a schema object' }
  }

  const zodSchema = schema as ZodSchemaLike
  if (isZod3Schema(zodSchema)) {
    return { unreadable: ZOD3_UNSUPPORTED_MESSAGE }
  }

  const node = objectNode(zodSchema)
  if (!node) {
    return { unreadable: `the params schema is a '${typeOf(zodSchema)}' node, not an object` }
  }

  // Re-checked here because a wrapper can hide a v3 node from the entry gate:
  // `z.optional(v3Object)` is a v4 wrapper around a v3 object.
  if (isZod3Schema(node)) {
    return { unreadable: ZOD3_UNSUPPORTED_MESSAGE }
  }

  const shape = objectShape(node)
  if (!shape) {
    return { unreadable: 'the params schema exposes no property shape' }
  }

  return {
    keys: Object.entries(shape).map(([name, value]) => ({
      name,
      omissible: permitsOmission(value),
    })),
  }
}

function formatList(names: Iterable<string>): string {
  return [...names].map((name) => `'${name}'`).join(', ')
}

/** The shared tail of every finding: rename the declaration, or widen the path. */
function renameSuggestion(what: string, pathParams: Set<string>): string {
  const target = pathParams.size > 0 ? formatList(pathParams) : 'the path declares none'
  return `Rename the ${what} to a parameter in the path (${target}), or add the parameter to the path.`
}

/**
 * Findings for one route: every `bind` key and params-schema key naming a parameter the
 * path does not have. The reverse direction is harmless and not reported — zod strips
 * undeclared keys, leaving the parameter unvalidated as it is with no schema at all.
 */
function checkRoute(route: RouteDefinition): CheckResult[] {
  const pathParams = new Set(extractPathParamNames(route.path))
  const results: CheckResult[] = []
  const undeclared = (names: string[]): string =>
    `${formatList(names)}, which '${route.path}' does not declare. `

  // Router-level `bind(param, Model)` entries are already filtered by path parameter, so
  // what is left came from the route's own `bind`. Not exhaustive: the serializer drops a
  // binding whose model class has no readable `name` (an anonymous class expression).
  const strayBindings = Object.keys(route.bindings ?? {}).filter((param) => !pathParams.has(param))
  if (strayBindings.length > 0) {
    results.push(
      check(
        `route-contract-bind:${route.method}:${route.path}`,
        `${route.method} ${route.path} model binding`,
        'fail',
        `bind names ${undeclared(strayBindings)}`
        + 'A binding for a parameter the path does not carry is skipped at request time, and the '
        + 'controller\'s this.model() then throws "No model binding found".',
        renameSuggestion('bind key', pathParams),
      ),
    )
  }

  const paramsSchema = route.schemas?.params
  if (!paramsSchema) return results

  const title = `${route.method} ${route.path} params schema`
  const parsed = readParamKeys(paramsSchema)
  if ('unreadable' in parsed) {
    results.push(
      check(
        `route-contract-params:${route.method}:${route.path}`,
        title,
        'warn',
        `Skipped: ${parsed.unreadable}.`,
        'Declare route params with a z.object() so the keys can be compared against the path.',
      ),
    )
    return results
  }

  // Split by severity: a required key rejects every request, an omissible one never
  // fails. Both statuses are pinned by packages/server/tests/route-contract-runtime.test.ts;
  // they differ by handler kind because the contract middleware throws ValidationException
  // where the functional path returns its own response.
  const stray = parsed.keys.filter((key) => !pathParams.has(key.name))
  const suggestion = renameSuggestion('schema key', pathParams)
  const required = stray.filter((key) => !key.omissible).map((key) => key.name)
  const omissible = stray.filter((key) => key.omissible).map((key) => key.name)

  if (required.length > 0) {
    results.push(
      check(
        `route-contract-params:${route.method}:${route.path}`,
        title,
        'fail',
        `The params schema requires ${undeclared(required)}`
        + 'The key is never present, so every request to this route fails validation with a 422 before '
        + 'the handler runs.',
        suggestion,
      ),
    )
  }

  if (omissible.length > 0) {
    results.push(
      check(
        `route-contract-params-optional:${route.method}:${route.path}`,
        title,
        'warn',
        `The params schema declares ${undeclared(omissible)}`
        + 'The key is optional, so nothing fails at request time: the controller reads undefined, or the '
        + 'schema default, in place of a value from the URL.',
        suggestion,
      ),
    )
  }

  return results
}

/**
 * Route contract checks: `params` and `bind` keys against the parameters their route path
 * declares (see {@link checkRoute} for why only that direction). Runs against loaded
 * definitions, not the routes file's AST: the registered path is the joined one, and a
 * params schema is usually imported from elsewhere. A clean run still emits one summary
 * pass, so it cannot be mistaken for a run that never happened.
 */
export async function checkRouteContracts(options: RouteContractCheckOptions): Promise<CheckResult[]> {
  const { cwd, routesFile = DEFAULT_ROUTES_FILE } = options

  let definitions = options.definitions
  if (!definitions) {
    if (!(await fileExists(cwd, routesFile))) return []

    try {
      definitions = await loadRouteDefinitions(resolve(cwd, routesFile), cwd)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Reported, never swallowed: silence is indistinguishable from every route matching.
      return [
        check(
          'route-contracts',
          'Route contracts',
          'warn',
          `Skipped: the route graph failed to load: ${message}`,
          'Fix the error, then run: bunx guren check',
          routesFile,
        ),
      ]
    }
  }

  const results = definitions.flatMap(checkRoute)
  if (results.length > 0) return results

  return [
    check(
      'route-contracts',
      'Route contracts',
      'pass',
      `${definitions.length} route${definitions.length === 1 ? '' : 's'} checked: every params schema key and `
      + 'model binding names a parameter its path declares.',
    ),
  ]
}
