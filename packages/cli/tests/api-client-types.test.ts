import { describe, expect, it, afterAll, afterEach, beforeAll } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { checkTypes, TSC_TIMEOUT, GENERATED_MODULE_COMPILER_OPTIONS } from './helpers'
import { buildApiClientContent, type RouteDefinitionLike } from '../src/api-client-types'

const definitions: RouteDefinitionLike[] = [
  // ':identifier' has ':id' as a prefix — the substitution suite below feeds
  // both keys at once, the exact shape a union route name produces.
  { method: 'GET', path: '/library/:identifier', name: 'library.show' },
  { method: 'GET', path: '/posts', name: 'posts.index' },
  { method: 'GET', path: '/posts/:id', name: 'posts.show' },
  { method: 'GET', path: '/items/:id{[0-9]+}', name: 'items.show' },
  { method: 'GET', path: '/inventory/:item-id{[0-9]+}', name: 'inventory.show' },
  { method: 'POST', path: '/posts', name: 'posts.store' },
  {
    method: 'QUERY',
    path: '/posts/search',
    name: 'posts.search',
    schemas: {
      body: z.object({ keywords: z.array(z.string()) }),
      output: z.object({ data: z.array(z.object({ id: z.number(), title: z.string() })) }),
    },
  },
  {
    method: 'GET',
    path: '/articles',
    name: 'articles.index',
    resource: { data: ['ArticleResource'] },
  },
]

const resources = [{ className: 'ArticleResource', dataName: 'Article' }]

// What data.gen.ts would carry for ArticleResource — the emitted client
// imports `Data` from this sibling, so the compile gate needs it on disk.
const DATA_GEN = `export namespace Data {
  export type Article = { id: number; title: string }
}
`

// One emitted module shared by every suite below: the compile gate reads the
// .ts source next to its usage probe, the runtime suite imports the
// transpiled .mjs.
let dir: string
let usageFile: string
let modulePath: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'guren-cli-api-client-'))
  usageFile = join(dir, 'usage.ts')
  modulePath = join(dir, 'api-client.gen.mjs')
  const source = buildApiClientContent(definitions, { resources })
  await Promise.all([
    writeFile(join(dir, 'api-client.gen.ts'), source, 'utf8'),
    writeFile(join(dir, 'data.gen.ts'), DATA_GEN, 'utf8'),
    writeFile(usageFile, USAGE_PROBE, 'utf8'),
    writeFile(modulePath, new Bun.Transpiler({ loader: 'ts' }).transformSync(source), 'utf8'),
  ])
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('buildApiClientContent', () => {
  it('emits the cookie-to-header names the CSRF middleware expects', () => {
    const content = buildApiClientContent(definitions)

    expect(content).toContain("const XSRF_COOKIE_NAME = 'XSRF-TOKEN'")
    expect(content).toContain("const XSRF_HEADER_NAME = 'X-XSRF-TOKEN'")
    // A bare `document.cookie` would need the DOM lib to type-check and would
    // throw on the server, so the lookup has to go through globalThis. Nothing
    // else in this file type-checks the emitted source: the create-app
    // template it lands in is excluded from every tsconfig.
    expect(content).toContain('(globalThis as { document?: { cookie?: string } }).document?.cookie')
  })

  it('types the response from a resource hint via the Data namespace', () => {
    const content = buildApiClientContent(definitions, { resources })

    expect(content).toContain("import type { Data } from './data.gen'")
    expect(content).toContain('response: { data: Array<Data.Article> }')
  })

  it('renders nested hints: bare classes, collections, and quoted envelope keys', () => {
    const content = buildApiClientContent(
      [{
        method: 'GET',
        path: '/feed',
        name: 'feed.index',
        resource: { entry: 'ArticleResource', 'kebab-key': ['ArticleResource'] },
      }],
      { resources },
    )

    expect(content).toContain("response: { entry: Data.Article; 'kebab-key': Array<Data.Article> }")
  })

  it('lets a bound output schema win over a resource hint', () => {
    const content = buildApiClientContent(
      [{
        method: 'GET',
        path: '/articles',
        name: 'articles.index',
        schemas: { output: z.object({ total: z.number() }) },
        resource: { data: ['ArticleResource'] },
      }],
      { resources },
    )

    expect(content).toContain('response: { total: number }')
    expect(content).not.toContain('Data.Article')
    // Nothing referenced Data, so the import must not be emitted — data.gen
    // may not even exist for an app whose only hints are shadowed.
    expect(content).not.toContain("from './data.gen'")
  })

  it('leaves the response untyped and warns when a hinted Resource is unknown', () => {
    const warnings: string[] = []
    const content = buildApiClientContent(
      [{
        method: 'GET',
        path: '/articles',
        name: 'articles.index',
        resource: { data: ['GhostResource'], author: 'ArticleResource' },
      }],
      { resources, warnings },
    )

    // The whole entry, verbatim: proves no response line landed on it (the
    // static client template legitimately mentions `response:` elsewhere).
    expect(content).toContain("  'articles.index': {\n    method: 'GET'\n    path: '/articles'\n  }")
    expect(content).not.toContain("from './data.gen'")
    expect(warnings).toEqual([
      'Route "articles.index" declares a resource response hint referencing "GhostResource", '
      + 'but no matching Resource class was found in app/Http/Resources (at the project root '
      + 'or under modules/*) — response left untyped.',
    ])
  })

  it('types a hint naming a Resource that lives in a module', () => {
    const warnings: string[] = []
    const content = buildApiClientContent(
      [{
        method: 'GET',
        path: '/invoices',
        name: 'invoices.index',
        resource: { data: ['InvoiceResource'] },
      }],
      { resources: [{ className: 'InvoiceResource', dataName: 'BillingInvoice' }], warnings },
    )

    // Module resources are emitted under a qualified `Data` member, and the
    // hint — which carries only the class name — has to find it there.
    expect(content).toContain('response: { data: Array<Data.BillingInvoice> }')
    expect(content).toContain("import type { Data } from './data.gen'")
    expect(warnings).toEqual([])
  })

  it('leaves the response untyped and warns when two app roots declare the class name', () => {
    const warnings: string[] = []
    const content = buildApiClientContent(
      [{
        method: 'GET',
        path: '/invoices',
        name: 'invoices.index',
        resource: 'InvoiceResource',
      }],
      {
        resources: [
          { className: 'InvoiceResource', dataName: 'BillingInvoice', filePath: 'modules/billing/app/Http/Resources/InvoiceResource.ts' },
          { className: 'InvoiceResource', dataName: 'InventoryInvoice', filePath: 'modules/inventory/app/Http/Resources/InvoiceResource.ts' },
        ],
        warnings,
      },
    )

    expect(content).toContain("  'invoices.index': {\n    method: 'GET'\n    path: '/invoices'\n  }")
    expect(content).not.toContain("from './data.gen'")
    expect(warnings).toEqual([
      'Route "invoices.index" declares a resource response hint referencing "InvoiceResource", '
      + 'which does not resolve to exactly one generated type '
      + '(modules/billing/app/Http/Resources/InvoiceResource.ts → Data.BillingInvoice; '
      + 'modules/inventory/app/Http/Resources/InvoiceResource.ts → Data.InventoryInvoice) — '
      + 'a hint carries only the class name, so it cannot say which. '
      + 'Response left untyped; see the data.gen.ts warnings above.',
    ])
  })

  it('keeps every candidate when three app roots declare the class name', () => {
    const warnings: string[] = []
    buildApiClientContent(
      [{ method: 'GET', path: '/invoices', name: 'invoices.index', resource: 'InvoiceResource' }],
      {
        resources: [
          { className: 'InvoiceResource', dataName: 'BillingInvoice' },
          { className: 'InvoiceResource', dataName: 'InventoryInvoice' },
          { className: 'InvoiceResource', dataName: 'SalesInvoice' },
        ],
        warnings,
      },
    )

    expect(warnings[0]).toContain('(Data.BillingInvoice; Data.InventoryInvoice; Data.SalesInvoice)')
  })

  it('refuses to resolve a class whose twin exists but was not emitted', () => {
    const warnings: string[] = []
    const content = buildApiClientContent(
      [{ method: 'GET', path: '/posts', name: 'posts.index', resource: 'PostResource' }],
      {
        // What data-types reports when `modules/2fa/`'s PostResource is
        // discovered but unemittable: the root one is NOT the only candidate,
        // so typing the route as Data.Post would hand it the wrong payload.
        resources: [
          { className: 'PostResource', dataName: 'Post', filePath: 'app/Http/Resources/PostResource.ts' },
          { className: 'PostResource', dataName: null, filePath: 'modules/2fa/app/Http/Resources/PostResource.ts' },
        ],
        warnings,
      },
    )

    expect(content).toContain("  'posts.index': {\n    method: 'GET'\n    path: '/posts'\n  }")
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('modules/2fa/app/Http/Resources/PostResource.ts → no generated type')
  })

  it('refuses a lone class that was discovered but produced no type', () => {
    const warnings: string[] = []
    buildApiClientContent(
      [{ method: 'GET', path: '/posts', name: 'posts.index', resource: 'PostResource' }],
      { resources: [{ className: 'PostResource', dataName: null }], warnings },
    )

    // Not "no matching Resource class" — it exists, it just has no Data member.
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('does not resolve to exactly one generated type')
  })

  it('reports both an unknown and an unresolvable leaf of one hint', () => {
    const warnings: string[] = []
    buildApiClientContent(
      [{
        method: 'GET',
        path: '/feed',
        name: 'feed.index',
        resource: { posts: ['PostResource'], ghost: 'GhostResource' },
      }],
      {
        resources: [
          { className: 'PostResource', dataName: 'Post' },
          { className: 'PostResource', dataName: 'BlogPost' },
        ],
        warnings,
      },
    )

    // Fixing either alone still leaves the route untyped, so both are said.
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toContain('"GhostResource"')
    expect(warnings[1]).toContain('"PostResource"')
  })
})

const USAGE_PROBE = `import { createApiClient, type ApiRoutes, type ApiRequestOptions } from './api-client.gen'

const client = createApiClient<ApiRoutes>({ baseUrl: 'http://localhost:3000' })

void client.request('posts.index')
void client.request('posts.show', { params: { id: 1 } })
void client.request('items.show', { params: { id: 1 } })
void client.request('inventory.show', { params: { 'item-id': 1 } })
void client.request('posts.search', { body: { keywords: ['guren'] } })

// @ts-expect-error the regex constraint must not leak into the param key
void client.request('items.show', { params: { 'id{[0-9]+}': 1 } })

// @ts-expect-error a route with path params requires them
void client.request('posts.show')

// @ts-expect-error unknown route names must not compile
void client.request('posts.missing')

// @ts-expect-error a bound body schema types the payload
void client.request('posts.search', { body: { keywords: 'guren' } })

// A bound output schema types json(); without one it stays unknown.
export const searchResults: { data: Array<{ id: number; title: string }> } =
  await (await client.request('posts.search', { body: { keywords: ['guren'] } })).json()

// @ts-expect-error routes without an output schema parse to unknown
export const untypedResults: { data: unknown[] } = await (await client.request('posts.index')).json()

// A resource response hint types json() from the generated Data namespace.
export const articles: { data: Array<{ id: number; title: string }> } =
  await (await client.request('articles.index')).json()

// @ts-expect-error the resource-hinted json() rejects a mismatched shape
export const wrongArticles: { data: Array<{ id: string }> } =
  await (await client.request('articles.index')).json()

// The assignability probe above would also pass if json() regressed to \`any\`
// (or \`never\`) — this one would not: both make the directive unused (TS2578).
// @ts-expect-error the typed json() rejects a mismatched shape
export const mismatchedResults: { data: Array<{ id: string }> } =
  await (await client.request('posts.search', { body: { keywords: ['guren'] } })).json()

// A union route name must stay callable in the way that is safe for every
// member: params are required whenever any member's path has them.
declare const eitherRoute: 'posts.index' | 'posts.show'
void client.request(eitherRoute, { params: { id: 1 } })

// @ts-expect-error a union name requires the params its members need
void client.request(eitherRoute)

// @ts-expect-error empty params must not satisfy a union name either
void client.request(eitherRoute, { params: {} })

export const indexOptions: ApiRequestOptions<'posts.index'> = {}
export const showOptions: ApiRequestOptions<'posts.show'> = { params: { id: 1 } }
export const unionOptions: ApiRequestOptions<'posts.index' | 'posts.show'> = { params: { id: 1 } }

// @ts-expect-error param-less routes reject a params member
export const paramsRejected: ApiRequestOptions<'posts.index'> = { params: {} }

// @ts-expect-error a route with path params requires them here too
export const paramsRequired: ApiRequestOptions<'posts.show'> = {}

// @ts-expect-error the union options type requires every member's params
export const unionParamsRequired: ApiRequestOptions<'posts.index' | 'posts.show'> = {}
`

const compilerOptions = GENERATED_MODULE_COMPILER_OPTIONS

/**
 * The emitted module's types are only exercised where a call site exists —
 * scaffolds compile the file, but with no consumer that proved nothing, which
 * is how `createApiClient<ApiRoutes>` shipped rejecting its own documented
 * usage twice (an interface never satisfies a `Record<...>` constraint, and
 * param-less routes' `Record<string, never>` made the params check demand
 * params). This gate is that call site: the `@ts-expect-error` probes keep it
 * able to fail in both directions (an accepted probe surfaces as TS2578).
 */
describe('generated api client types', () => {
  it('compiles the documented usage against the emitted module', () => {
    expect(checkTypes([usageFile], compilerOptions)).toEqual([])
  }, TSC_TIMEOUT)
})

/**
 * The generated file is app-facing code, so the assertions above only prove it
 * mentions the right names. These run it: transpile the emitted TypeScript,
 * import it, and drive `request()` against a stubbed `document`/`fetch`.
 */
describe('generated createApiClient', () => {
  type CreateApiClient = (config: {
    baseUrl: string
    headers?: Record<string, string>
    credentials?: RequestCredentials
  }) => {
    request: (
      name: string,
      options?: { params?: Record<string, string | number>; body?: unknown },
    ) => Promise<Response>
  }

  const PAGE_ORIGIN = 'http://localhost:3000'
  const originalFetch = globalThis.fetch
  const originalGlobals = globalThis as { document?: unknown; location?: unknown }
  const restore = { document: originalGlobals.document, location: originalGlobals.location }

  let createApiClient: CreateApiClient

  beforeAll(async () => {
    createApiClient = (await import(pathToFileURL(modulePath).href)).createApiClient
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    for (const key of ['document', 'location'] as const) {
      if (restore[key] === undefined) delete originalGlobals[key]
      else originalGlobals[key] = restore[key]
    }
  })

  function stubFetch(): { calls: Array<{ url: string; init: RequestInit }> } {
    const calls: Array<{ url: string; init: RequestInit }> = []
    globalThis.fetch = ((url: string, init: RequestInit) => {
      calls.push({ url, init })
      return Promise.resolve(new Response(null, { status: 204 }))
    }) as typeof fetch
    return { calls }
  }

  /** Bun defines neither global, so a browser has to be stubbed in whole. */
  function browsingAt(origin: string, cookie: string): void {
    originalGlobals.document = { cookie }
    originalGlobals.location = { href: `${origin}/current-page`, origin }
  }

  function headersOf(init: RequestInit): Record<string, string> {
    return init.headers as Record<string, string>
  }

  it('substitutes params through Hono modifiers in the URL', async () => {
    const { calls } = stubFetch()

    await createApiClient({ baseUrl: 'http://api.example.com' }).request('items.show', { params: { id: 7 } })

    expect(calls[0]!.url).toBe('http://api.example.com/items/7')
  })

  it('substitutes hyphenated param labels, matching the emitted params type', async () => {
    const { calls } = stubFetch()

    await createApiClient({ baseUrl: 'http://api.example.com' }).request('inventory.show', { params: { 'item-id': 7 } })

    expect(calls[0]!.url).toBe('http://api.example.com/inventory/7')
  })

  it('sends the decoded cookie value as X-XSRF-TOKEN on mutating requests', async () => {
    const { calls } = stubFetch()
    browsingAt(PAGE_ORIGIN, 'other=1; XSRF-TOKEN=token%2Fwith%2Fslashes; another=2')

    await createApiClient({ baseUrl: PAGE_ORIGIN }).request('posts.store', { body: { title: 'hi' } })

    expect(headersOf(calls[0]!.init)['X-XSRF-TOKEN']).toBe('token/with/slashes')
    expect(calls[0]!.init.credentials).toBe('same-origin')
  })

  it('resolves a relative baseUrl against the page', async () => {
    const { calls } = stubFetch()
    browsingAt(PAGE_ORIGIN, 'XSRF-TOKEN=abc')

    await createApiClient({ baseUrl: '' }).request('posts.store', { body: {} })

    expect(headersOf(calls[0]!.init)['X-XSRF-TOKEN']).toBe('abc')
  })

  it('matches the cookie name exactly, not by prefix', async () => {
    const { calls } = stubFetch()
    browsingAt(PAGE_ORIGIN, 'NOT-XSRF-TOKEN=wrong; XSRF-TOKEN-OLD=stale; XSRF-TOKEN=right')

    await createApiClient({ baseUrl: PAGE_ORIGIN }).request('posts.store', { body: {} })

    expect(headersOf(calls[0]!.init)['X-XSRF-TOKEN']).toBe('right')
  })

  // A union route name requires every member's params, so request() gets
  // handed keys the selected path does not bind. Token-based substitution
  // keeps those a no-op — a per-key replace loop would let the ':id' pass
  // corrupt '/library/:identifier' into '/library/1entifier' before
  // ':identifier' could ever match.
  it('substitutes whole param tokens, so extra or prefix-colliding keys cannot corrupt the path', async () => {
    const { calls } = stubFetch()
    browsingAt(PAGE_ORIGIN, 'XSRF-TOKEN=abc')

    await createApiClient({ baseUrl: PAGE_ORIGIN }).request('library.show', { params: { id: 1, identifier: 2 } })

    expect(calls[0]!.url).toBe(`${PAGE_ORIGIN}/library/2`)
  })

  it('omits the header on safe methods', async () => {
    const { calls } = stubFetch()
    browsingAt(PAGE_ORIGIN, 'XSRF-TOKEN=abc')

    await createApiClient({ baseUrl: PAGE_ORIGIN }).request('posts.index')

    expect(headersOf(calls[0]!.init)['X-XSRF-TOKEN']).toBeUndefined()
  })

  // QUERY is CSRF-exempt server-side by default, so the token is redundant —
  // but an app can opt QUERY into protection via the middleware's `methods`
  // option, and the client keeping the header is what makes that opt-in work.
  it('sends the QUERY method with a body and the XSRF header', async () => {
    const { calls } = stubFetch()
    browsingAt(PAGE_ORIGIN, 'XSRF-TOKEN=abc')

    await createApiClient({ baseUrl: PAGE_ORIGIN }).request('posts.search', { body: { q: 'hi' } })

    expect(calls[0]!.init.method).toBe('QUERY')
    expect(calls[0]!.init.body).toBe(JSON.stringify({ q: 'hi' }))
    expect(headersOf(calls[0]!.init)['X-XSRF-TOKEN']).toBe('abc')
  })

  // The cookie belongs to the page's origin. Attaching it to a caller-supplied
  // cross-origin baseUrl would disclose this page's CSRF token to that server,
  // which only needs a permissive CORS policy to collect it.
  it('never sends the page token to another origin', async () => {
    const { calls } = stubFetch()
    browsingAt(PAGE_ORIGIN, 'XSRF-TOKEN=secret')

    await createApiClient({ baseUrl: 'https://third-party.example' }).request('posts.store', { body: {} })

    expect(headersOf(calls[0]!.init)['X-XSRF-TOKEN']).toBeUndefined()
  })

  // Header names are case-insensitive over the wire, so the caller's spelling
  // must not decide whether their token survives: matching case-sensitively
  // either overwrites an explicit token or leaves two conflicting keys behind.
  for (const headerName of ['X-XSRF-TOKEN', 'x-xsrf-token', 'X-CSRF-TOKEN', 'x-csrf-token']) {
    it(`keeps a caller-supplied ${headerName} header`, async () => {
      const { calls } = stubFetch()
      browsingAt(PAGE_ORIGIN, 'XSRF-TOKEN=from-cookie')

      const client = createApiClient({
        baseUrl: PAGE_ORIGIN,
        headers: { [headerName]: 'explicit' },
      })
      await client.request('posts.store', { body: {} })

      const headers = headersOf(calls[0]!.init)
      const tokenHeaders = Object.entries(headers).filter(([key]) => key.toLowerCase().endsWith('srf-token'))
      expect(tokenHeaders).toEqual([[headerName, 'explicit']])
    })
  }

  it('makes no request-time assumptions about document outside the browser', async () => {
    const { calls } = stubFetch()
    delete originalGlobals.document
    delete originalGlobals.location

    await createApiClient({ baseUrl: PAGE_ORIGIN }).request('posts.store', { body: {} })

    expect(headersOf(calls[0]!.init)['X-XSRF-TOKEN']).toBeUndefined()
  })

  it('honours an explicit credentials mode for cross-origin clients', async () => {
    const { calls } = stubFetch()
    browsingAt(PAGE_ORIGIN, 'XSRF-TOKEN=abc')

    const client = createApiClient({ baseUrl: 'https://api.example.com', credentials: 'include' })
    await client.request('posts.store', { body: {} })

    expect(calls[0]!.init.credentials).toBe('include')
  })
})
