import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ParseCache } from '../src/parse-cache'
import { routePathMatches, scanTestRequests, testCoverage, type TestRequestRoute, type TestRequestScan } from '../src/test-requests'
import { writeWorkspaceFiles } from './helpers'

let ROOT: string
let counter = 0

const IMPORT = "import { TestApp } from '@guren/testing'\nimport app from '../src/app'\n"

const ROUTES: TestRequestRoute[] = [
  { method: 'GET', path: '/posts' },
  { method: 'POST', path: '/posts' },
  { method: 'GET', path: '/posts/:id' },
  { method: 'PATCH', path: '/posts/:id', toolName: 'posts_update' },
  { method: 'POST', path: '/posts/:post/comments' },
  { method: 'GET', path: '/archive/:year{[0-9]+}' },
]

async function scan(files: Record<string, string>): Promise<TestRequestScan> {
  counter += 1
  const dir = join(ROOT, `app-${counter}`)
  await writeWorkspaceFiles(dir, files)
  return scanTestRequests(dir, Object.keys(files).map((file) => join(dir, file)), new ParseCache())
}

async function scanOne(source: string): Promise<TestRequestScan> {
  return scan({ 'tests/posts.test.ts': source })
}

/** `METHOD path -> reached route` per request, in source order. */
function reached(result: TestRequestScan, routes = ROUTES): string[] {
  const coverage = testCoverage(result, routes)
  return result.requests.map((request) => {
    const hits = [...coverage.byRoute].filter(([, sites]) => sites.some((site) => site.line === request.line && site.file === request.file))
    return `${request.text} -> ${hits.map(([index]) => `${routes[index]!.method} ${routes[index]!.path}`).join(' | ') || 'none'}`
  })
}

beforeAll(async () => {
  ROOT = await mkdtemp(join(tmpdir(), 'guren-test-requests-'))
})

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true })
})

describe('scanTestRequests on paths', () => {
  test('should match a static path, a parameter and a query string against the route graph', async () => {
    const result = await scanOne(`${IMPORT}
let http: TestApp
http = await TestApp.fromApp(app)
await http.get('/posts?page=2').assertOk()
await http.get('/posts/1').assertOk()
await http.post('/posts/1/comments', { body: 'x' }).assertStatus(201)
await http.get('http://localhost/posts')
`)
    expect(reached(result)).toEqual([
      'GET /posts?page=2 -> GET /posts',
      'GET /posts/1 -> GET /posts/:id',
      'POST /posts/1/comments -> POST /posts/:post/comments',
      'GET http://localhost/posts -> GET /posts',
    ])
  })

  test('should resolve a template literal through a file constant, and take a whole-segment substitution for a parameter', async () => {
    const result = await scanOne(`${IMPORT}
const POSTS = '/posts'
const http = await TestApp.fromApp(app)
const id = Math.random()
await http.get(\`\${POSTS}/\${id}\`)
await http.patch(POSTS + '/' + id, {})
await http.post(\`/posts/\${id}/comments?x=\${id}\`, {})
`)
    expect(reached(result)).toEqual([
      'GET /posts/${…} -> GET /posts/:id',
      'PATCH /posts/${…} -> PATCH /posts/:id',
      'POST /posts/${…}/comments?x=${…} -> POST /posts/:post/comments',
    ])
  })

  test('should report a path it cannot spell as unresolved, never guess a route for it', async () => {
    const result = await scanOne(`${IMPORT}
const http = await TestApp.fromApp(app)
function url(): string { return '/posts' }
export async function visit(path: string) { await http.get(path) }
await http.get(url())
await http.get(\`\${base}/posts\`)
await http.get(\`/posts/p-\${1 + 1}\`)
`)
    expect(result.requests).toEqual([])
    expect(result.unresolved.map((request) => `${request.line} ${request.reason} ${request.text}`)).toEqual([
      '6 dynamicPath GET <runtime>',
      '7 dynamicPath GET <runtime>',
      '8 dynamicPath GET ${…}/posts',
      '9 partialSegment GET /posts/p-${…}',
    ])
  })

  test('should call a runtime segment that fits no parameter unresolved, and a spelled path that fits no route unmatched', async () => {
    const result = await scanOne(`${IMPORT}
const http = await TestApp.fromApp(app)
await http.delete(\`/comments/\${1}\`)
await http.get('/nowhere')
`)
    const coverage = testCoverage(result, ROUTES)
    expect(coverage.byRoute.size).toBe(0)
    expect(coverage.unresolved.map((request) => `${request.reason} ${request.text}`)).toEqual(['noRoute DELETE /comments/${…}'])
    expect(coverage.unmatched.map((request) => request.text)).toEqual(['GET /nowhere'])
  })
})

describe('scanTestRequests on receivers', () => {
  test('should follow an import alias, a builder chain, a function returning one, and withCsrf', async () => {
    const result = await scanOne(`import { TestApp as App } from '@guren/testing'
import app from '../src/app'
const base = await App.fromApp(app)
function asAuthor(): App { return base.actingAs({ id: 1 }) }
const asAdmin = () => base.withHeaders({ Authorization: 'x' })
async function signedIn(): Promise<App> { return base.withCsrf('/login') }
await asAuthor().post('/posts', {})
await asAdmin().json().get('/posts')
const primed = await base.withCsrf()
await primed.post('/posts', {})
await (await signedIn()).get('/posts/2')
`)
    expect(reached(result)).toEqual([
      'GET /login -> none',
      'POST /posts -> POST /posts',
      'GET /posts -> GET /posts',
      'GET / -> none',
      'POST /posts -> POST /posts',
      'GET /posts/2 -> GET /posts/:id',
    ])
  })

  test('should count neither a comment, a string, nor a get() on something that is not a TestApp', async () => {
    const result = await scanOne(`${IMPORT}
const http = await TestApp.fromApp(app)
// http.get('/posts')
const note = "http.get('/posts')"
const cache = new Map<string, number>()
cache.get('/posts')
const response = await http.get('/posts/3')
response.headers.get('/posts')
`)
    expect(reached(result)).toEqual(['GET /posts/3 -> GET /posts/:id'])
  })

  test('should read nothing from a file that never names TestApp', async () => {
    const result = await scanOne("const http = { get(path: string) { return path } }\nhttp.get('/posts')\n")
    expect(result.requests).toEqual([])
    expect(result.unresolved).toEqual([])
  })

  test('should map agent().call() to the route publishing the tool', async () => {
    const result = await scanOne(`${IMPORT}
const http = await TestApp.fromApp(app)
await http.agent().call('posts_update', { id: 1 })
const agent = http.agent()
await agent.call('posts_update', {})
await agent.call(process.env.TOOL!, {})
`)
    expect(reached(result)).toEqual([
      "agent().call('posts_update') -> PATCH /posts/:id",
      "agent().call('posts_update') -> PATCH /posts/:id",
    ])
    expect(result.unresolved.map((request) => request.reason)).toEqual(['dynamicPath'])
  })

  test('should name a test file that mentions TestApp and does not parse', async () => {
    const result = await scan({
      'tests/broken.test.ts': `${IMPORT}\nconst http = await TestApp.fromApp(app\n`,
      'tests/other.test.ts': 'const x = {\n',
    })
    expect(result.unparsed).toEqual(['tests/broken.test.ts'])
  })
})

describe('routePathMatches', () => {
  test('should compare parameters, a regex constraint, an optional last parameter and a wildcard', () => {
    const literal = (...parts: string[]) => parts.map((part) => ({ literal: part }))
    expect(routePathMatches('/posts/:id', literal('posts', '7'))).toBe(true)
    expect(routePathMatches('/posts/:id', literal('posts'))).toBe(false)
    expect(routePathMatches('/posts', literal('posts', '7'))).toBe(false)
    expect(routePathMatches('/archive/:year{[0-9]+}', literal('archive', '2024'))).toBe(true)
    expect(routePathMatches('/archive/:year{[0-9]+}', literal('archive', 'latest'))).toBe(false)
    expect(routePathMatches('/feed/:format?', literal('feed'))).toBe(true)
    expect(routePathMatches('/feed/:format?', literal('feed', 'rss'))).toBe(true)
    expect(routePathMatches('/assets/*', literal('assets', 'a', 'b.css'))).toBe(true)
    expect(routePathMatches('/', [])).toBe(true)
    expect(routePathMatches('/posts/create', [{ literal: 'posts' }, { runtime: true }])).toBe(false)
    expect(routePathMatches('/posts/:id', [{ literal: 'posts' }, { runtime: true }])).toBe(true)
  })
})
