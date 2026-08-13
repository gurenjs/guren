/**
 * Generates a typed API client registry from route definitions.
 *
 * Combines route manifest data with Resource data types to produce
 * a fully typed client interface for consuming Guren APIs from
 * separate frontend applications.
 */
import { resolve } from 'node:path'
import type { ResourceResponseShape } from '@guren/core'
import { escapeSingleQuoted as escapeSingleQuotes, quoteObjectKey, resolveAppRoot, writeGeneratedFileIn, type WriterOptions } from './utils'
import { PATH_PARAM_TYPE_HELPERS } from './routes-types-fragments'
import { schemaToTypeString } from './schema-type-extractor'
import type { ResourceDefinition } from './data-types'

export interface RouteDefinitionLike {
  method: string
  path: string
  name?: string
  schemas?: {
    params?: unknown
    query?: unknown
    body?: unknown
    output?: unknown
  }
  /**
   * Serialized response hint from `RouteContractOptions.resource`: a Resource
   * class name, a single-element array (a collection), or an envelope object
   * of either.
   */
  resource?: ResourceResponseShape
}

/**
 * The subset of data-types' ResourceDefinition the client generator needs:
 * the class name a hint serializes to, and the `Data` namespace member it
 * resolves to (e.g. 'PostResource' → `Data.Post`).
 */
export type ResourceTypeRef = Pick<ResourceDefinition, 'className' | 'dataName'>

export interface GenerateApiClientOptions extends WriterOptions {
  appRoot?: string
  outputFile?: string
  /**
   * Resource classes discovered by `generateDataTypes()`. Routes declaring a
   * `resource` hint resolve their response types against these — without
   * them every hint is "unknown Resource" and stays untyped.
   */
  resources?: ResourceTypeRef[]
}

const DEFAULT_OUTPUT_FILE = '.guren/api-client.gen.ts'

export interface ApiRouteEntry {
  name: string
  method: string
  path: string
}

export async function generateApiClientTypes(
  definitions: RouteDefinitionLike[],
  options: GenerateApiClientOptions = {},
): Promise<{ outputPath: string; warnings: string[] }> {
  const appRoot = resolveAppRoot(options)
  const outputFile = resolve(appRoot, options.outputFile ?? DEFAULT_OUTPUT_FILE)

  // Returned rather than logged (same contract as generateOpenApiSpec), so
  // programmatic callers — the MCP codegen tool above all — can surface them
  // to whoever asked for the regeneration.
  const warnings: string[] = []
  const module = buildApiClientContent(definitions, { resources: options.resources, warnings })

  const outputPath = await writeGeneratedFileIn(appRoot, outputFile, module, { force: options.force })

  return { outputPath, warnings }
}

export interface BuildApiClientOptions {
  resources?: ResourceTypeRef[]
  /** Sink for per-route notes about hints that could not be resolved. */
  warnings?: string[]
}

interface ResourceShapeContext {
  dataNames: Map<string, string>
  missing: Set<string>
  usedData: boolean
}

function resourceShapeToType(shape: ResourceResponseShape, context: ResourceShapeContext): string {
  if (typeof shape === 'string') {
    const dataName = context.dataNames.get(shape)
    if (!dataName) {
      context.missing.add(shape)
      return 'unknown'
    }
    context.usedData = true
    return `Data.${dataName}`
  }

  if (Array.isArray(shape)) {
    return `Array<${resourceShapeToType(shape[0], context)}>`
  }

  const entries = Object.entries(shape).map(
    ([key, value]) => `${quoteObjectKey(key)}: ${resourceShapeToType(value, context)}`,
  )
  return entries.length > 0 ? `{ ${entries.join('; ')} }` : '{}'
}

export function buildApiClientContent(
  definitions: RouteDefinitionLike[],
  options: BuildApiClientOptions = {},
): string {
  const named = definitions
    .filter((d): d is RouteDefinitionLike & { name: string } => Boolean(d.name))
    .sort((a, b) => a.name.localeCompare(b.name))

  const dataNames = new Map((options.resources ?? []).map((r) => [r.className, r.dataName]))
  let importsData = false

  // `output` wins over `resource` when a route declares both: the schema is
  // the one actually enforced at runtime, the hint is only a claim.
  const responseTypeOf = (d: RouteDefinitionLike & { name: string }): string | undefined => {
    if (d.schemas?.output) return schemaToTypeString(d.schemas.output, { io: 'output' })
    if (d.resource === undefined) return undefined

    const context: ResourceShapeContext = { dataNames, missing: new Set(), usedData: false }
    const rendered = resourceShapeToType(d.resource, context)
    if (context.missing.size > 0) {
      // All-or-nothing: a response typed around an unresolved leaf would
      // assert a shape the server does not send. Untyped stays honest.
      options.warnings?.push(
        `Route "${d.name}" declares a resource response hint referencing `
        + `${Array.from(context.missing).map((n) => `"${n}"`).join(', ')}, `
        + 'but no matching Resource class was found in app/Http/Resources — response left untyped.',
      )
      return undefined
    }
    importsData ||= context.usedData
    return rendered
  }

  const routeEntries = named
    .map((d) => {
      const bodyType = d.schemas?.body ? schemaToTypeString(d.schemas.body, { io: 'input' }) : undefined
      const responseType = responseTypeOf(d)
      let entry = `  '${escapeSingleQuotes(d.name)}': {
    method: '${d.method}'
    path: '${escapeSingleQuotes(d.path)}'`
      if (bodyType) entry += `\n    body: ${bodyType}`
      if (responseType) entry += `\n    response: ${responseType}`
      entry += '\n  }'
      return entry
    })
    .join('\n')

  // The Data import resolves against the sibling data.gen.ts — both artifacts
  // land in .guren/ and `guren codegen` always writes data.gen first.
  const dataImport = importsData ? "\nimport type { Data } from './data.gen'\n" : ''

  return `// Generated — DO NOT EDIT
// Run \`guren codegen\` to regenerate.
${dataImport}
/**
 * Typed API route registry.
 * Use with \`createApiClient<ApiRoutes>()\` for end-to-end type safety.
 *
 * \`body\` is the *request* shape — what you send. Coercing schemas are rendered
 * as they travel: \`z.coerce.date()\` is a \`string\` here, not the \`Date\` the
 * controller ends up with. \`response\` is the parsed shape you get back.
 * Params are not stored on the entries: they are derived from each entry's
 * \`path\` literal, the same string the server routes on.
 */
export interface ApiRoutes {
${routeEntries || '  // No named routes found'}
}

export type ApiRouteName = keyof ApiRoutes

export type ApiRouteMethod<T extends ApiRouteName> = ApiRoutes[T]['method']
export type ApiRoutePath<T extends ApiRouteName> = ApiRoutes[T]['path']

${PATH_PARAM_TYPE_HELPERS}
export type ApiRouteParams<T extends ApiRouteName> = PathParamsOf<ApiRoutePath<T>>

// The request body type a route declares through its bound schema — \`unknown\`
// for routes without one.
type BodyOf<TRoute> = TRoute extends { body: infer TBody } ? TBody : unknown

// The parsed shape a route declares through its bound output schema —
// \`unknown\` for routes without one.
type ResponseOf<TRoute> = TRoute extends { response: infer TResponse } ? TResponse : unknown

// The runtime object is the plain fetch \`Response\`; only \`json()\` is narrowed
// to the route's declared response shape.
export interface TypedResponse<TData> extends Response {
  json(): Promise<TData>
}

// Params derive from the path literal, so nothing about how the entries above
// are emitted can silently flip \`request()\`'s call arity. Deliberately not
// distributed over a union route name (the conditional checks
// \`HasPathParams<...>\`, never a bare type parameter): the union of paths
// yields the union of their param keys, so an un-narrowed name requires every
// member's params — substituting a param a member's path lacks is a runtime
// no-op, while the reverse (accepting one member's empty params) would send a
// path with its \`:param\` unresolved.
type RequestOptionsOf<TRoute extends { path: string }> =
  HasPathParams<TRoute['path']> extends false
    ? { params?: never; body?: BodyOf<TRoute>; query?: Record<string, unknown> }
    : { params: PathParamsOf<TRoute['path']>; body?: BodyOf<TRoute>; query?: Record<string, unknown> }

// Param-less routes may omit the options argument entirely; the same
// predicate that shapes the options decides the arity.
type RequestArgsOf<TRoute extends { path: string }> =
  HasPathParams<TRoute['path']> extends false
    ? [options?: RequestOptionsOf<TRoute>]
    : [options: RequestOptionsOf<TRoute>]

export type ApiRequestOptions<T extends ApiRouteName> = RequestOptionsOf<ApiRoutes[T]>

// The wire contract these mirror is owned by Guren's CSRF middleware: it
// writes the XSRF-TOKEN cookie and reads either header name. Change them
// together.
const XSRF_COOKIE_NAME = 'XSRF-TOKEN'
const XSRF_HEADER_NAME = 'X-XSRF-TOKEN'
// QUERY (RFC 10008) is deliberately NOT listed even though the server's CSRF
// default skips it: the redundant token header is harmless there, and keeping
// it is what makes a server that opts QUERY into protection (the middleware's
// \`methods\` option) work with this client unchanged.
const CSRF_SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS']
const CSRF_HEADER_NAMES = [XSRF_HEADER_NAME.toLowerCase(), 'x-csrf-token']

/**
 * Read the \`XSRF-TOKEN\` cookie issued by Guren's CSRF middleware.
 *
 * Reached through \`globalThis\` so this module stays importable — and
 * type-checkable — outside the browser, where \`document\` does not exist.
 */
function readXsrfToken(): string | undefined {
  const cookies = (globalThis as { document?: { cookie?: string } }).document?.cookie
  if (!cookies) return undefined
  for (const part of cookies.split(';')) {
    const entry = part.trim()
    if (!entry.startsWith(\`$\{XSRF_COOKIE_NAME}=\`)) continue
    const value = entry.slice(XSRF_COOKIE_NAME.length + 1)
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }
  return undefined
}

/**
 * Whether \`url\` targets the page's own origin.
 *
 * The \`XSRF-TOKEN\` cookie belongs to that origin, so it must never ride along
 * to a third-party \`baseUrl\`: that would hand this page's CSRF token to
 * another server, which a permissive CORS policy there is enough to accept.
 * Outside the browser there is no origin — and no cookie — so nothing is sent.
 */
function isSameOrigin(url: string): boolean {
  const location = (globalThis as { location?: { href?: string; origin?: string } }).location
  if (!location?.href || !location.origin) return false
  try {
    return new URL(url, location.href).origin === location.origin
  } catch {
    return false
  }
}

/**
 * Create a typed API client for consuming Guren routes.
 *
 * Same-origin state-changing requests automatically copy the \`XSRF-TOKEN\`
 * cookie into the \`X-XSRF-TOKEN\` header, which is what Guren's CSRF
 * middleware expects. Pass your own \`X-XSRF-TOKEN\` / \`X-CSRF-TOKEN\` header
 * to opt out — you have to, for a \`baseUrl\` on another origin (the cookie is
 * never sent there) or for a server configured with \`csrf({ cookie: false })\`.
 * Cookies follow the \`credentials\` option (\`'same-origin'\` by default; use
 * \`'include'\` cross-origin, with a CORS setup that allows it).
 *
 * Routes that bind a \`body\` schema type the \`body\` option with that schema's
 * request shape; routes without one accept \`unknown\`. Routes that bind an
 * \`output\` schema type the response: \`json()\` on the returned \`Response\`
 * resolves to that schema's parsed shape. A \`resource\` response hint types
 * \`json()\` the same way from the \`Data\` types extracted out of
 * app/Http/Resources — declared, not validated: the server never checks the
 * payload against it at runtime. Without either, \`json()\` resolves to
 * \`unknown\` — validate before trusting it. Either way the typed shape
 * describes the success body only: error statuses carry their own (a 422
 * from validation is \`{ errors: ... }\`), so check \`ok\` before reading it.
 *
 * @example
 * \`\`\`typescript
 * import type { ApiRoutes } from '@/.guren/api-client.gen'
 *
 * const client = createApiClient<ApiRoutes>({ baseUrl: 'http://localhost:3000' })
 * const posts = await client.request('posts.index')
 * const post = await client.request('posts.show', { params: { id: 1 } })
 * \`\`\`
 */
// The mapped-object constraint (rather than \`Record<...>\`) is what lets the
// generated \`ApiRoutes\` interface satisfy it — interfaces have no implicit
// index signature, so \`Record<string, ...>\` would reject them.
export function createApiClient<TRoutes extends { [K in keyof TRoutes]: { method: string; path: string } }>(
  config: { baseUrl: string; headers?: Record<string, string>; credentials?: RequestInit['credentials'] },
) {
  return {
    async request<TName extends keyof TRoutes & string>(
      name: TName,
      ...args: RequestArgsOf<TRoutes[TName]>
    ): Promise<TypedResponse<ResponseOf<TRoutes[TName]>>> {
      const route = (routes as Record<string, { method: string; path: string }>)[name]
      if (!route) throw new Error(\`Route [\${name}] not defined.\`)

      const opts = (args as unknown[])[0] as { params?: Record<string, unknown>; body?: unknown; query?: Record<string, unknown> } | undefined
      let path = route.path
      if (opts?.params) {
        for (const [key, value] of Object.entries(opts.params)) {
          path = path.replace(\`:$\{key}\`, encodeURIComponent(String(value)))
        }
      }

      let url = \`$\{config.baseUrl}$\{path}\`
      if (opts?.query) {
        const search = new URLSearchParams()
        for (const [k, v] of Object.entries(opts.query)) {
          if (v != null) search.set(k, String(v))
        }
        const qs = search.toString()
        if (qs) url += \`?$\{qs}\`
      }

      const method = route.method.toUpperCase()
      const headers: Record<string, string> = { 'Content-Type': 'application/json', ...config.headers }
      if (
        !CSRF_SAFE_METHODS.includes(method) &&
        !Object.keys(headers).some((key) => CSRF_HEADER_NAMES.includes(key.toLowerCase())) &&
        isSameOrigin(url)
      ) {
        const token = readXsrfToken()
        if (token) headers[XSRF_HEADER_NAME] = token
      }

      const init: RequestInit = {
        method,
        headers,
        credentials: config.credentials ?? 'same-origin',
      }
      if (opts?.body && method !== 'GET') {
        init.body = JSON.stringify(opts.body)
      }

      return fetch(url, init)
    },
  }
}

const routes: Record<string, { method: string; path: string }> = {
${named.map((d) => `  '${escapeSingleQuotes(d.name)}': { method: '${d.method}', path: '${escapeSingleQuotes(d.path)}' },`).join('\n')}
}
`
}

