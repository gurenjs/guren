/**
 * Generates a typed API client registry from route definitions.
 *
 * Combines route manifest data with Resource data types to produce
 * a fully typed client interface for consuming Guren APIs from
 * separate frontend applications.
 */
import { relative, resolve } from 'node:path'
import { escapeSingleQuoted as escapeSingleQuotes, writeGeneratedFile, type WriterOptions } from './utils'
import { schemaToTypeString } from './schema-type-extractor'

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
}

export interface GenerateApiClientOptions extends WriterOptions {
  appRoot?: string
  outputFile?: string
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
): Promise<{ outputPath: string }> {
  const appRoot = options.appRoot ? resolve(options.appRoot) : process.cwd()
  const outputFile = resolve(appRoot, options.outputFile ?? DEFAULT_OUTPUT_FILE)

  const module = buildApiClientContent(definitions)

  const relativeTarget = relative(process.cwd(), outputFile) || outputFile
  const outputPath = await writeGeneratedFile(relativeTarget, module, { force: options.force })

  return { outputPath }
}

export function buildApiClientContent(definitions: RouteDefinitionLike[]): string {
  const named = definitions
    .filter((d): d is RouteDefinitionLike & { name: string } => Boolean(d.name))
    .sort((a, b) => a.name.localeCompare(b.name))

  const routeEntries = named
    .map((d) => {
      const params = extractParams(d.path)
      const paramsType = params.length > 0
        ? `{ ${params.map((p) => `${p}: string | number`).join('; ')} }`
        : 'Record<string, never>'
      const bodyType = d.schemas?.body ? schemaToTypeString(d.schemas.body, { io: 'input' }) : undefined
      const responseType = d.schemas?.output ? schemaToTypeString(d.schemas.output, { io: 'output' }) : undefined
      let entry = `  '${escapeSingleQuotes(d.name)}': {
    method: '${d.method}'
    path: '${escapeSingleQuotes(d.path)}'
    params: ${paramsType}`
      if (bodyType) entry += `\n    body: ${bodyType}`
      if (responseType) entry += `\n    response: ${responseType}`
      entry += '\n  }'
      return entry
    })
    .join('\n')

  return `// Generated — DO NOT EDIT
// Run \`guren codegen\` to regenerate.

/**
 * Typed API route registry.
 * Use with \`createApiClient<ApiRoutes>()\` for end-to-end type safety.
 *
 * \`body\` is the *request* shape — what you send. Coercing schemas are rendered
 * as they travel: \`z.coerce.date()\` is a \`string\` here, not the \`Date\` the
 * controller ends up with. \`response\` is the parsed shape you get back.
 */
export interface ApiRoutes {
${routeEntries || '  // No named routes found'}
}

export type ApiRouteName = keyof ApiRoutes

export type ApiRouteMethod<T extends ApiRouteName> = ApiRoutes[T]['method']
export type ApiRoutePath<T extends ApiRouteName> = ApiRoutes[T]['path']
export type ApiRouteParams<T extends ApiRouteName> = ApiRoutes[T]['params']

type HasParams<T extends ApiRouteName> =
  [keyof ApiRoutes[T]['params']] extends [never] ? false : true

export type ApiRequestOptions<T extends ApiRouteName> =
  HasParams<T> extends true
    ? { params: ApiRouteParams<T>; body?: unknown; query?: Record<string, unknown> }
    : { params?: never; body?: unknown; query?: Record<string, unknown> }

// The wire contract these mirror is owned by Guren's CSRF middleware: it
// writes the XSRF-TOKEN cookie and reads either header name. Change them
// together.
const XSRF_COOKIE_NAME = 'XSRF-TOKEN'
const XSRF_HEADER_NAME = 'X-XSRF-TOKEN'
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
 * @example
 * \`\`\`typescript
 * import type { ApiRoutes } from '@/.guren/api-client.gen'
 *
 * const client = createApiClient<ApiRoutes>({ baseUrl: 'http://localhost:3000' })
 * const posts = await client.request('posts.index')
 * const post = await client.request('posts.show', { params: { id: 1 } })
 * \`\`\`
 */
export function createApiClient<TRoutes extends Record<string, { method: string; path: string; params: unknown }>>(
  config: { baseUrl: string; headers?: Record<string, string>; credentials?: RequestInit['credentials'] },
) {
  return {
    async request<TName extends keyof TRoutes & string>(
      name: TName,
      ...args: [keyof TRoutes[TName]['params']] extends [never]
        ? [options?: { body?: unknown; query?: Record<string, unknown> }]
        : [options: { params: TRoutes[TName]['params']; body?: unknown; query?: Record<string, unknown> }]
    ): Promise<Response> {
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

function extractParams(path: string): string[] {
  const matches = path.match(/:([A-Za-z0-9_]+)/g)
  return matches ? matches.map((m) => m.slice(1)) : []
}

