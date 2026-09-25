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
import { joinManifestRoutes } from './app-routes'
import { check, type CheckEvidence, type CheckResult } from './check-result'
import { fileExists } from './discovery'
import { DEFAULT_ROUTES_FILE, loadRouteDefinitionsWithModules } from './load-routes'
import { introspectedRoutes, judgedFromManifest, judgedFromSource, type IntrospectSource } from './manifest-section'
import { extractPathParamNames } from './utils'

export type RouteContractCheckOptions = {
  cwd: string
  /** Routes entry file, POSIX-relative to `cwd`. Defaults to `routes/web.ts`. */
  routesFile?: string
  /**
   * The run's introspection (RFC 0026 §5), asked for once a definition declares a params schema
   * or a binding: the introspected app's routes are judged instead, the routes file's Zod standing
   * in for a params schema the manifest cannot render whole.
   */
  introspect?: IntrospectSource
} & (
  | { definitions?: undefined; definitionModules?: undefined }
  /** Definitions to check instead of loading them, with `loadRouteDefinitions()`'s `moduleIdentities`, so the Zod fallback joins within each module. */
  | { definitions: RouteDefinition[]; definitionModules: readonly (string | null)[] }
)

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
 * `tests/route-introspect.test.ts` pins the two equal, so a fix aimed at an OpenAPI
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
 * them and `required` gives their severity. `short` says why the rendering may lack keys: not an
 * object with properties (a nullable object, a bare `z.transform()` or `z.preprocess()`, an
 * unreadable node), or a `schema-partial` note under it. The walker also drops some keys with no
 * note (`z.undefined()`), which only the Zod shows.
 */
function manifestParamKeys(
  entry: RouteEntry,
  schema: NonNullable<RouteEntry['schemas']['params']>,
  warnings: AppManifest['warnings'],
): { keys: ParamKey[] } | { short: string } {
  if ('unreadable' in schema) return { short: schema.unreadable }
  if (schema.type !== 'object' || !schema.properties) return { short: 'the introspected app renders the params schema as something other than an object with properties' }
  const route = `${entry.method} ${entry.path}`
  const partial = warnings.find((warning) =>
    warning.code === 'schema-partial' && warning.route === route && warning.message.startsWith(`${route} params`))
  if (partial) return { short: `the introspected app renders the params schema only in part (${partial.message.replace(/\.$/u, '')})` }
  const required = new Set(schema.required ?? [])
  return { keys: Object.keys(schema.properties).map((name) => ({ name, omissible: !required.has(name) })) }
}

const keyNames = (result: { keys: ParamKey[] }): string => result.keys.map((key) => key.name).sort().join('\n')

/**
 * Which reading judges one manifest route's params: the manifest's, unless the routes file's Zod
 * for the same route reads keys the rendering lacks, or the rendering is short of the schema;
 * then the Zod (`static`), and with no Zod the schema is reported unreadable.
 */
function manifestParams(
  entry: RouteEntry,
  warnings: AppManifest['warnings'],
  definition: RouteDefinition | undefined,
): { parsed?: ParamKeysResult; evidence?: CheckEvidence } {
  const declared = entry.schemas.params
  if (!declared) return {}
  const fromManifest = manifestParamKeys(entry, declared, warnings)
  const fromZod = definition ? staticParamKeys(definition) : undefined
  if ('short' in fromManifest) {
    return fromZod
      ? { parsed: fromZod, evidence: 'static' }
      : { parsed: { unreadable: `${fromManifest.short.replace(/\.$/u, '')}, and the routes file registers no route to read its Zod from` } }
  }
  if (fromZod && !('keys' in fromZod && keyNames(fromZod) === keyNames(fromManifest))) return { parsed: fromZod, evidence: 'static' }
  return { parsed: fromManifest }
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

  let { definitions, definitionModules: modules } = options
  if (!definitions || !modules) {
    if (!(await fileExists(cwd, routesFile))) return []

    try {
      const loaded = await loadRouteDefinitionsWithModules(resolve(cwd, routesFile), cwd)
      definitions = loaded.definitions
      modules = loaded.modules
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
  const introspected = declaresContract ? await introspectedRoutes(options.introspect) : undefined

  if (introspected?.status === 'described') {
    const { routes, warnings } = introspected.manifest
    const joined = joinManifestRoutes(routes, definitions, modules)
    const results = routes.flatMap((entry, index) => {
      const { parsed, evidence } = manifestParams(entry, warnings, joined[index])
      return checkRoute(entry, parsed).map((result) => (evidence ? { ...result, evidence } : result))
    })
    return judgedFromManifest(results.length > 0 ? results : [summary(routes.length)])
  }

  const results = definitions.flatMap((definition) => checkRoute(definition, staticParamKeys(definition)))
  return judgedFromSource(results.length > 0 ? results : [summary(definitions.length)], introspected?.reason)
}
