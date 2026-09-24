import { resolve } from 'node:path'
import type { AppManifest, RouteDefinition, RouteEntry } from '@guren/server'
import {
  isZod3Schema,
  objectShape,
  pipeSides,
  typeOf,
  unwrapSingleChild,
  ZOD3_UNSUPPORTED_MESSAGE,
  type ZodSchemaLike,
} from '@guren/server/internal/zod-compat'
import { joinRouteDefinitions } from './app-routes'
import { check, type CheckEvidence, type CheckResult } from './check-result'
import { fileExists } from './discovery'
import { DEFAULT_ROUTES_FILE, loadRouteDefinitions } from './load-routes'
import { introspectedRoutes, judgedFromSource, type IntrospectSource } from './manifest-section'
import { extractPathParamNames } from './utils'

export interface RouteContractCheckOptions {
  cwd: string
  /** Routes entry file, POSIX-relative to `cwd`. Defaults to `routes/web.ts`. */
  routesFile?: string
  /** Definitions to check instead of loading them; absent, this loads its own. */
  definitions?: RouteDefinition[]
  /**
   * The run's introspection (RFC 0026 §5), asked for once a definition declares a params schema
   * or a binding: the introspected app's routes are judged instead, the routes file's Zod standing
   * in for a params schema the manifest cannot render whole.
   */
  introspect?: IntrospectSource
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
 * on purpose: under-reporting files a real 422 as advice. Kept apart from the JSON Schema
 * walker's `isOptional(schema, 'input')`, whose `required` the manifest path reads instead;
 * `tests/route-contract-introspect.test.ts` pins the two equal, so a fix aimed at an OpenAPI
 * document fails there rather than silently reclassifying a finding.
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
function checkRoute(
  route: Pick<RouteDefinition, 'method' | 'path' | 'bindings'>,
  parsed: ParamKeysResult | undefined,
): CheckResult[] {
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

  if (!parsed) return results

  const title = `${route.method} ${route.path} params schema`
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

/** A registered definition's params keys, read from its Zod; `undefined` when it declares none. */
function staticParamKeys(definition: RouteDefinition): ParamKeysResult | undefined {
  return definition.schemas?.params ? readParamKeys(definition.schemas.params) : undefined
}

/**
 * A manifest route's params keys from its JSON Schema (RFC 0026 Decision 5): `properties` names
 * them and `required` gives their severity. Undefined when the rendering may be short of the
 * schema: not an object with properties (a nullable or piped object, a transform, an unreadable
 * node), or a `schema-partial` note under it, since the walker drops a property it cannot render.
 */
function manifestParamKeys(entry: RouteEntry, warnings: AppManifest['warnings']): ParamKeysResult | undefined {
  const schema = entry.schemas.params
  if (!schema || 'unreadable' in schema || schema.type !== 'object' || !schema.properties) return undefined
  const label = `${entry.method} ${entry.path} params`
  if (warnings.some((warning) => warning.code === 'schema-partial' && warning.message.startsWith(label))) return undefined
  const required = new Set(schema.required ?? [])
  return { keys: Object.keys(schema.properties).map((name) => ({ name, omissible: !required.has(name) })) }
}

function sameKeys(left: ParamKeysResult, right: ParamKeysResult): boolean {
  if ('unreadable' in left || 'unreadable' in right) return false
  const names = (result: { keys: ParamKey[] }): string => result.keys.map((key) => key.name).sort().join('\n')
  return names(left) === names(right)
}

/**
 * One manifest route's findings. Its keys come from the manifest, unless the routes file's Zod
 * for the same route reads keys the rendering lacks, or the rendering is short of the schema:
 * then the Zod decides (`static`), and with no Zod the schema is reported unreadable.
 */
function checkManifestRoute(
  entry: RouteEntry,
  warnings: AppManifest['warnings'],
  definition: RouteDefinition | undefined,
): CheckResult[] {
  const declared = entry.schemas.params
  const fromZod = definition ? staticParamKeys(definition) : undefined
  const fromManifest = manifestParamKeys(entry, warnings)
  let parsed: ParamKeysResult | undefined
  let evidence: CheckEvidence = 'manifest'
  if (!declared) {
    parsed = undefined
  } else if (fromManifest && (!fromZod || sameKeys(fromManifest, fromZod))) {
    parsed = fromManifest
  } else if (fromZod) {
    parsed = fromZod
    evidence = 'static'
  } else {
    parsed = { unreadable: 'unreadable' in declared ? declared.unreadable : 'the introspected app renders the params schema without every key it declares' }
  }
  return checkRoute(entry, parsed).map((result) => ({ ...result, evidence }))
}

function summary(count: number): CheckResult {
  return check(
    'route-contracts',
    'Route contracts',
    'pass',
    `${count} route${count === 1 ? '' : 's'} checked: every params schema key and `
    + 'model binding names a parameter its path declares.',
  )
}

/**
 * Route contract checks: `params` and `bind` keys against the parameters their route path
 * declares (see {@link checkRoute}). Runs against registered definitions, not the AST: the
 * registered path is the joined one, and a params schema is usually imported from elsewhere.
 * Introspected, the app's own routes are judged, a provider's included. A clean run still
 * emits one summary pass, so it cannot be mistaken for a run that never happened.
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

  // Content-activated like RFC 0026 Part 2b: only a params schema or a binding starts the child.
  const declaresContract = definitions.some((definition) =>
    definition.schemas?.params || Object.keys(definition.bindings ?? {}).length > 0)
  const introspected = declaresContract && options.introspect ? await introspectedRoutes(options.introspect) : undefined

  if (introspected?.status === 'described') {
    const { routes, warnings } = introspected.manifest
    const joined = joinRouteDefinitions(routes, definitions)
    const results = routes.flatMap((entry, index) => checkManifestRoute(entry, warnings, joined[index]))
    if (results.length > 0) return results
    return [{ ...summary(routes.length), evidence: 'manifest' }]
  }

  const results = definitions.flatMap((definition) => checkRoute(definition, staticParamKeys(definition)))
  return judgedFromSource(results.length > 0 ? results : [summary(definitions.length)], introspected?.reason)
}
