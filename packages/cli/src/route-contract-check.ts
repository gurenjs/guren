import { resolve } from 'node:path'
import type { RouteDefinition } from '@guren/core'
import {
  innerSchema,
  isZod3Schema,
  objectShape,
  pipeSide,
  PRESENCE_WRAPPERS,
  TRANSPARENT_WRAPPERS,
  typeOf,
  ZOD3_UNSUPPORTED_MESSAGE,
  type ZodSchemaLike,
} from '@guren/core/internal/zod-compat'
import { check, type CheckResult } from './check-result'
import { fileExists } from './discovery'
import { DEFAULT_ROUTES_FILE, loadRouteDefinitions } from './load-routes'
import { isOptional } from './schema-type-extractor'
import { extractPathParamNames } from './utils'

export interface RouteContractCheckOptions {
  cwd: string
  /** Routes entry file, POSIX-relative to `cwd`. Defaults to `routes/web.ts`. */
  routesFile?: string
  /**
   * Route definitions already loaded by the caller. Supplied so a full
   * `guren check` evaluates the route graph once instead of once per suite;
   * omitted, this loads them itself.
   */
  definitions?: RouteDefinition[]
}

/**
 * How deep {@link objectNode} follows wrappers before giving up. A params
 * schema is a flat object under at most a couple of wrappers, so any depth
 * beyond this is a cycle (`z.lazy` reads its inner schema from `_def.getter`,
 * which {@link innerSchema} cannot see, but nothing rules out a future node
 * shape that loops) rather than a schema worth reading.
 */
const MAX_UNWRAP_DEPTH = 16

/**
 * The `object` node inside a params schema, looking through the wrappers that
 * do not change what keys exist. `.pipe()` is read on its input side, because
 * a path parameter's presence is decided by what the *request* carries.
 *
 * Returns undefined for anything that is not ultimately an object — a union of
 * objects, say. That is a schema this check cannot read, not a schema that
 * passes: {@link readParamKeys} turns it into a reported skip.
 */
function objectNode(schema: ZodSchemaLike, depth = 0): ZodSchemaLike | undefined {
  if (depth > MAX_UNWRAP_DEPTH) return undefined

  const type = typeOf(schema)
  if (type === 'object') return schema

  const def = schema._def ?? {}

  if (TRANSPARENT_WRAPPERS.has(type) || PRESENCE_WRAPPERS.has(type)) {
    const inner = innerSchema(def)
    return inner ? objectNode(inner, depth + 1) : undefined
  }

  if (type === 'pipe') {
    const side = pipeSide(def, 'input')
    return side ? objectNode(side, depth + 1) : undefined
  }

  return undefined
}

interface ParamKey {
  name: string
  /** Whether a request may leave this key out without the schema rejecting it. */
  omissible: boolean
}

type ParamKeysResult =
  | { keys: ParamKey[] }
  | { unreadable: string }

/**
 * The keys a params schema declares, or the reason they could not be read.
 *
 * Never collapses "unreadable" into "no keys": a schema this walker cannot
 * follow would otherwise report as a route with nothing to check, which reads
 * exactly like a route that matched.
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

  const shape = objectShape(node)
  if (!shape) {
    return { unreadable: 'the params schema exposes no property shape' }
  }

  return {
    keys: Object.entries(shape).map(([name, value]) => ({
      name,
      // 'input' because a path parameter that the path never supplies is a key
      // missing from what the request carries, which is the input side.
      omissible: isOptional(value, 'input'),
    })),
  }
}

function formatList(names: string[]): string {
  return names.map((name) => `'${name}'`).join(', ')
}

function routeLabel(route: RouteDefinition): string {
  return `${route.method} ${route.path}`
}

/**
 * Findings for one route: every `bind` key and every params-schema key that
 * names a parameter the path does not have.
 *
 * The reverse direction is deliberately not reported. A path parameter absent
 * from the params schema is harmless — zod's object strips keys it does not
 * declare, so the parameter simply goes unvalidated, which is what a route
 * with no params schema at all already does.
 */
function checkRoute(route: RouteDefinition): CheckResult[] {
  const pathParams = new Set(extractPathParamNames(route.path))
  const label = routeLabel(route)
  const results: CheckResult[] = []

  // Router-level `bind(param, Model)` entries are filtered by path parameter
  // before they reach a definition, so anything left over here came from the
  // route's own `bind` option — the one that is a claim about *this* path.
  //
  // Not exhaustive, and cannot be: the serializer drops a binding whose model
  // class has no readable `name` (an anonymous class expression), so such a
  // binding is invisible to this check.
  const strayBindings = Object.keys(route.bindings ?? {}).filter((param) => !pathParams.has(param))
  if (strayBindings.length > 0) {
    results.push(
      check(
        `route-contract-bind:${route.method}:${route.path}`,
        `${label} model binding`,
        'fail',
        `bind names ${formatList(strayBindings)}, which '${route.path}' does not declare. `
        + 'A binding for a parameter the path does not carry is skipped at request time, and the '
        + 'controller\'s this.model() then throws "No model binding found".',
        `Rename the bind key to a parameter in the path (${
          pathParams.size > 0 ? formatList([...pathParams]) : 'the path declares none'
        }), or add the parameter to the path.`,
      ),
    )
  }

  const paramsSchema = route.schemas?.params
  if (!paramsSchema) return results

  const parsed = readParamKeys(paramsSchema)
  if ('unreadable' in parsed) {
    results.push(
      check(
        `route-contract-params:${route.method}:${route.path}`,
        `${label} params schema`,
        'warn',
        `Skipped: ${parsed.unreadable}.`,
        'Declare route params with a z.object() so the keys can be compared against the path.',
      ),
    )
    return results
  }

  const stray = parsed.keys.filter((key) => !pathParams.has(key.name))
  if (stray.length === 0) return results

  // Split by severity rather than reported together: a required key is a
  // guaranteed 400 on every request, while an omissible one never fails at
  // all — and `.default()`, the worst of the two, quietly hands the
  // controller a value that has nothing to do with the URL.
  const required = stray.filter((key) => !key.omissible).map((key) => key.name)
  const omissible = stray.filter((key) => key.omissible).map((key) => key.name)
  const suggestion = `Rename the schema key to a parameter in the path (${
    pathParams.size > 0 ? formatList([...pathParams]) : 'the path declares none'
  }), or add the parameter to the path.`

  if (required.length > 0) {
    results.push(
      check(
        `route-contract-params:${route.method}:${route.path}`,
        `${label} params schema`,
        'fail',
        `The params schema requires ${formatList(required)}, which '${route.path}' does not declare. `
        + 'The key is never present, so every request to this route fails validation with 400.',
        suggestion,
      ),
    )
  }

  if (omissible.length > 0) {
    results.push(
      check(
        `route-contract-params-optional:${route.method}:${route.path}`,
        `${label} params schema`,
        'warn',
        `The params schema declares ${formatList(omissible)}, which '${route.path}' does not declare. `
        + 'The key is optional, so nothing fails at request time: the controller reads undefined, or the '
        + 'schema default, in place of a value from the URL.',
        suggestion,
      ),
    )
  }

  return results
}

/**
 * Route contract checks: `params` schema keys and `bind` keys against the
 * parameters their route path actually declares (see {@link checkRoute} for
 * why only that direction is reported).
 *
 * Runs against loaded definitions rather than the routes file's AST because
 * the path a route registers is the *joined* one — `group()` prefixes and
 * `resource()` expansions are already applied — and because a params schema
 * is usually imported from elsewhere, so its keys are not in the routes file
 * to read.
 *
 * Reports nothing when every declaration matches except a single summary
 * pass, which is what distinguishes a clean run from one that never
 * happened.
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
      // A load failure is reported, never swallowed: staying silent here is
      // indistinguishable from every route matching its path.
      return [
        check(
          'route-contracts',
          'Route contracts',
          'warn',
          `Skipped: the route graph failed to load: ${message}`,
          `Fix the error, then run: bunx guren check`,
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
