import { describe, expect, it, afterAll, afterEach, beforeAll } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildApiClientContent, type RouteDefinitionLike } from '../src/api-client-types'

const definitions: RouteDefinitionLike[] = [
  { method: 'GET', path: '/posts', name: 'posts.index' },
  { method: 'POST', path: '/posts', name: 'posts.store' },
  { method: 'QUERY', path: '/posts/search', name: 'posts.search' },
]

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
  }) => { request: (name: string, options?: { body?: unknown }) => Promise<Response> }

  const PAGE_ORIGIN = 'http://localhost:3000'
  const originalFetch = globalThis.fetch
  const originalGlobals = globalThis as { document?: unknown; location?: unknown }
  const restore = { document: originalGlobals.document, location: originalGlobals.location }

  let dir: string
  let createApiClient: CreateApiClient

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'guren-cli-api-client-'))
    const source = buildApiClientContent(definitions)
    const modulePath = join(dir, 'api-client.gen.mjs')
    await writeFile(modulePath, new Bun.Transpiler({ loader: 'ts' }).transformSync(source), 'utf8')
    createApiClient = (await import(pathToFileURL(modulePath).href)).createApiClient
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
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
