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
  /**
   * Definitions to check instead of loading them. `runCheck` loads the graph
   * once and passes it here and to the agent-route checks; tests pass
   * hand-built definitions. Absent, this loads its own.
   */
  definitions?: RouteDefinition[]
}

/**
 * The direction every walk in this file looks *through* a wrapper: a params
 * schema describes what arrives in the URL, never what a parse produces.
 */
const REQUEST_SIDE = 'input'

/**
 * The `object` node inside a params schema, looking through every wrapper
 * that does not change which keys exist.
 *
 * Returns undefined for anything that is not ultimately an object — a union
 * of objects, say. That is a schema this check cannot read, not a schema that
 * passes: {@link readParamKeys} turns it into a reported skip.
 */
function objectNode(schema: ZodSchemaLike): ZodSchemaLike | undefined {
  if (typeOf(schema) === 'object') {
    return schema
  }

  const nested = unwrapSingleChild(schema, REQUEST_SIDE)
  return nested ? objectNode(nested) : undefined
}

/**
 * Whether a request may leave this key out without the schema rejecting it.
 *
 * Errs toward over-reporting on purpose: an approximation that over-reports
 * severity costs a reader one look, and one that under-reports files a real
 * 422 as advice. That is why the CLI's *type* renderer cannot answer this —
 * it reads only the side of a `.pipe()` it renders, which is right for naming
 * a type and wrong here, calling `z.string().optional().pipe(z.string())`
 * omissible when the second stage rejects a missing value and every request
 * without the key gets a 422.
 *
 * `zod-compat` hosts the vocabulary and the step that applies it
 * (`unwrapSingleChild`), but no caller's optionality policy, and this is the
 * third such policy. Be aware it is currently *identical* to the JSON Schema
 * walker's `isOptional(schema, 'input')` — that convergence is deliberate, not
 * an oversight, and it is still kept apart for two reasons. Hosting one of the
 * three centrally would make it read as authoritative and the other two as
 * deviants, when all three are documented approximations a sufficiently odd
 * pipeline can fool. And it would put this check's user-visible severity
 * downstream of the JSON Schema walker's `required` semantics, so a change
 * made to fix an OpenAPI document would silently reclassify a `guren check`
 * finding.
 */
function permitsOmission(schema: ZodSchemaLike): boolean {
  const def = schema._def ?? {}

  switch (typeOf(schema)) {
    case 'optional':
      return true

    // Both fill the missing value in, so nothing rejects the request.
    // `.default()` is the case worth naming: the controller reads a value
    // that has nothing to do with the URL.
    case 'default':
    case 'prefault':
    // Swallows any failure, a missing value included.
    case 'catch':
      return true

    // Re-requires a key an inner wrapper made omissible, so the walk stops
    // here rather than reading what it wraps.
    case 'nonoptional':
      return false

    // A pipeline runs both stages, so the key may be omitted only if neither
    // rejects a missing value. Still an approximation in the safe direction:
    // a transforming stage can supply a value the next stage accepts, which
    // this reports as required.
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
  const results: CheckResult[] = []
  const undeclared = (names: string[]): string =>
    `${formatList(names)}, which '${route.path}' does not declare. `

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

  // Split by severity rather than reported together: a required key rejects
  // every request, while an omissible one never fails at all — and
  // `.default()`, the worse of the two, quietly hands the controller a value
  // that has nothing to do with the URL. Both statuses are pinned by
  // `packages/server/tests/route-contract-runtime.test.ts`; they differ by
  // handler kind because the contract middleware throws ValidationException
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
 * pass, which is what distinguishes a clean run from one that never happened.
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
