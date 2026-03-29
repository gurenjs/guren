/**
 * Generates a typed API client registry from route definitions.
 *
 * Combines route manifest data with Resource data types to produce
 * a fully typed client interface for consuming Guren APIs from
 * separate frontend applications.
 */
import { relative, resolve } from 'node:path'
import { writeFileSafe, type WriterOptions } from './utils'
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
  const outputPath = await writeFileSafe(relativeTarget, module, { force: options.force })

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
      const bodyType = d.schemas?.body ? schemaToTypeString(d.schemas.body) : undefined
      const responseType = d.schemas?.output ? schemaToTypeString(d.schemas.output) : undefined
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

/**
 * Create a typed API client for consuming Guren routes.
 *
 * @example
 * \`\`\`typescript
 * import type { ApiRoutes } from '../.guren/api-client.gen'
 *
 * const client = createApiClient<ApiRoutes>({ baseUrl: 'http://localhost:3000' })
 * const posts = await client.request('posts.index')
 * const post = await client.request('posts.show', { params: { id: 1 } })
 * \`\`\`
 */
export function createApiClient<TRoutes extends Record<string, { method: string; path: string; params: unknown }>>(
  config: { baseUrl: string; headers?: Record<string, string> },
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

      const init: RequestInit = {
        method: route.method,
        headers: { 'Content-Type': 'application/json', ...config.headers },
      }
      if (opts?.body && route.method !== 'GET') {
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

function escapeSingleQuotes(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}
