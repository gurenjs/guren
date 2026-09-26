import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Router } from '@guren/core'
import { Hono } from 'hono'

import { extractClassDeclaration } from '../src/model-parser'
import { ParseCache, parseSourceFile } from '../src/parse-cache'
import { BUILDERS, REQUEST_METHODS, routePathCovers, routePathMatches, scanTestRequests, testCoverage, type TestRequestRoute, type TestRequestScan, type TestRequestSegment } from '../src/test-requests'
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

  test('should leave a request that was compared with every route and fits none out of both lists', async () => {
    const result = await scanOne(`${IMPORT}
const http = await TestApp.fromApp(app)
await http.delete(\`/comments/\${1}\`)
await http.get('/nowhere')
await http.get('/posts/')
`)
    const coverage = testCoverage(result, ROUTES)
    expect(coverage.byRoute.size).toBe(0)
    expect(coverage.unresolved).toEqual([])
  })

  test("should call a route whose constraint it cannot compile uncertain, never unmatched, and compile hono's `\\_`", async () => {
    const routes: TestRequestRoute[] = [{ method: 'GET', path: '/tags/:slug{[a-z\\_]+}' }, { method: 'GET', path: '/odd/:id{(}' }]
    const result = await scanOne(`${IMPORT}
const http = await TestApp.fromApp(app)
await http.get('/tags/a_b')
await http.get('/odd/1')
`)
    const coverage = testCoverage(result, routes)
    expect([...coverage.byRoute.keys()]).toEqual([0])
    expect(coverage.uncertainByRoute.get(1)?.map((request) => `${request.reason} ${request.method} ${request.text}`)).toEqual(['routePattern GET GET /odd/1'])
  })
})

describe('testCoverage in registration order', () => {
  type RegisteredTestRoute = TestRequestRoute & { module: string | null }
  const MEETUPS: RegisteredTestRoute[] = [
    { method: 'GET', path: '/meetups/create', module: null },
    { method: 'GET', path: '/meetups/:id', module: null },
  ]
  const SOURCE = `${IMPORT}
const http = await TestApp.fromApp(app)
await http.get('/meetups/create')
await http.get('/meetups/1')
`

  /** Per request, `route` for each one it reaches and `route?reason` for each it may reach. */
  function answered(result: TestRequestScan, routes: RegisteredTestRoute[], modulesIncomplete = false): string[] {
    const coverage = testCoverage(result, routes, { registered: { provenance: routes.map((route) => route.module), modulesIncomplete } })
    const label = (index: number): string => `${routes[index]!.method} ${routes[index]!.path}`
    return result.requests.map((request) => {
      const at = (site: { file: string; line: number }): boolean => site.file === request.file && site.line === request.line
      const hits = [...coverage.byRoute].filter(([, sites]) => sites.some(at)).map(([index]) => label(index))
      const maybe = [...coverage.uncertainByRoute].flatMap(([index, sites]) => sites.filter(at).map((site) => `${label(index)}?${site.reason}`))
      return `${request.text} -> ${[...hits, ...maybe].join(' | ') || 'none'}`
    })
  }

  test('should give a request only to the route registered first of the two its path matches', async () => {
    const result = await scanOne(SOURCE)
    expect(answered(result, MEETUPS)).toEqual(['GET /meetups/create -> GET /meetups/create', 'GET /meetups/1 -> GET /meetups/:id'])
    expect(answered(result, [MEETUPS[1]!, MEETUPS[0]!])).toEqual(['GET /meetups/create -> GET /meetups/:id', 'GET /meetups/1 -> GET /meetups/:id'])
  })

  test('should list every matching route when the routes carry no registration order', async () => {
    const result = await scanOne(SOURCE)
    expect(reached(result, MEETUPS)).toEqual(['GET /meetups/create -> GET /meetups/create | GET /meetups/:id', 'GET /meetups/1 -> GET /meetups/:id'])
  })

  test("should put the entry registrar's routes first and leave two modules' routes unordered", async () => {
    const result = await scanOne(SOURCE)
    const entryFirst: RegisteredTestRoute[] = [{ ...MEETUPS[1]!, module: 'events' }, MEETUPS[0]!]
    expect(answered(result, entryFirst)).toEqual(['GET /meetups/create -> GET /meetups/create', 'GET /meetups/1 -> GET /meetups/:id'])
    const twoModules: RegisteredTestRoute[] = [{ ...MEETUPS[0]!, module: 'events' }, { ...MEETUPS[1]!, module: 'calendar' }]
    expect(answered(result, twoModules)).toEqual([
      'GET /meetups/create -> GET /meetups/create?routeOrder | GET /meetups/:id?routeOrder',
      'GET /meetups/1 -> GET /meetups/:id',
    ])
    expect(answered(result, entryFirst, true)).toEqual(['GET /meetups/create -> GET /meetups/create', 'GET /meetups/1 -> GET /meetups/:id?routeOrder'])
  })

  test('should let an earlier ALL route answer, and an earlier route it cannot judge leave the later one uncertain', async () => {
    const result = await scanOne(SOURCE)
    expect(answered(result, [{ method: 'ALL', path: '/meetups/*', module: null }, ...MEETUPS])).toEqual([
      'GET /meetups/create -> ALL /meetups/*',
      'GET /meetups/1 -> ALL /meetups/*',
    ])
    const runtime = await scanOne(`${IMPORT}
const http = await TestApp.fromApp(app)
const id = 1
await http.get(\`/meetups/\${id}\`)
`)
    expect(answered(runtime, [{ method: 'GET', path: '/meetups/:id{[0-9]+}', module: null }, { method: 'GET', path: '/meetups/:slug', module: null }])).toEqual([
      'GET /meetups/${…} -> GET /meetups/:id{[0-9]+}?routePattern | GET /meetups/:slug?routeOrder',
    ])
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

  test('should read nothing from a receiver that is neither a TestApp nor what an imported function returns', async () => {
    const result = await scanOne("const http = { get(path: string) { return path } }\nhttp.get('/posts')\n")
    expect(result.requests).toEqual([])
    expect(result.unresolved).toEqual([])
  })

  test('should take TestApp through a namespace import', async () => {
    const result = await scanOne(`import * as testing from '@guren/testing'
import app from '../src/app'
let http: testing.TestApp
http = await testing.TestApp.fromApp(app)
await http.get('/posts')
const other = await testing.TestApp.fromApp(app)
await other.get('/posts/1')
`)
    expect(reached(result)).toEqual(['GET /posts -> GET /posts', 'GET /posts/1 -> GET /posts/:id'])
  })

  test('should call a request on what an imported helper returns unresolved, with its method', async () => {
    const result = await scanOne(`import { testApp, headersOf } from './support/app'
const http = await testApp()
await http.post('/posts', {})
await (await testApp()).actingAs({ id: 1 }).get(\`/posts/\${1}\`)
headersOf().get('Location')
`)
    expect(result.requests).toEqual([])
    expect(result.unresolved.map((request) => `${request.line} ${request.reason} ${request.method}`)).toEqual([
      '3 unknownReceiver POST',
      '4 unknownReceiver GET',
    ])
  })

  test('should call a request on what a same-file function returns unresolved when nothing annotates it a TestApp', async () => {
    const result = await scanOne(`${IMPORT}
async function signedIn() {
  return TestApp.fromApp(app)
}
async function typed(): Promise<TestApp> {
  return TestApp.fromApp(app)
}
const http = await signedIn()
await http.post('/posts', {})
await (await typed()).get('/posts')
`)
    expect(reached(result)).toEqual(['GET /posts -> GET /posts'])
    expect(result.unresolved.map((request) => `${request.line} ${request.reason} ${request.method}`)).toEqual(['11 localReceiver POST'])
  })

  // The receiver loop is synchronous, so a test timeout cannot stop it: the scan runs in a child killed after 10 s.
  test('should settle when one name is bound to an imported helper and an unannotated local one, reporting the imported reason', async () => {
    counter += 1
    const dir = join(ROOT, `app-${counter}`)
    await writeWorkspaceFiles(dir, {
      'tests/a.test.ts': `${IMPORT}import { makeClient } from './helpers'
async function signedIn() {
  return TestApp.fromApp(app)
}
describe('one', () => {
  test('a', async () => {
    const http = await makeClient()
    await http.get('/posts')
  })
})
describe('two', () => {
  test('b', async () => {
    const http = await signedIn()
    await http.get('/posts')
  })
})
`,
      'scan.ts': `import { ParseCache } from ${JSON.stringify(fileURLToPath(new URL('../src/parse-cache.ts', import.meta.url)))}
import { scanTestRequests } from ${JSON.stringify(fileURLToPath(new URL('../src/test-requests.ts', import.meta.url)))}
const scan = await scanTestRequests(${JSON.stringify(dir)}, [${JSON.stringify(join(dir, 'tests/a.test.ts'))}], new ParseCache())
console.log(JSON.stringify(scan.unresolved.map((request) => request.line + ' ' + request.reason)))
`,
    })
    const run = Bun.spawnSync([process.execPath, join(dir, 'scan.ts')], { cwd: dir, stdout: 'pipe', stderr: 'pipe', timeout: 10_000 })

    expect(run.exitCode).toBe(0)
    expect(JSON.parse(run.stdout.toString())).toEqual(['10 unknownReceiver', '16 unknownReceiver'])
  }, 20_000)

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
  const literal = (path: string): TestRequestSegment[] => path.slice(1).split('/').map((part) => ({ literal: part }))
  const HONO_CASES: Array<[string, string]> = [
    ['/posts/:id', '/posts/7'], ['/posts/:id', '/posts'], ['/posts/:id', '/posts/'], ['/posts', '/posts/7'],
    ['/posts', '/posts/'], ['/posts/', '/posts'], ['/', '/'], ['/a//b', '/a//b'], ['/a//b', '/a/b'],
    ['/archive/:year{[0-9]+}', '/archive/2024'], ['/archive/:year{[0-9]+}', '/archive/latest'],
    ['/tags/:slug{[a-z\\_]+}', '/tags/a_b'], ['/files/:path{.+}', '/files/a/b'], ['/files/:path{.+}', '/files/a'],
    ['/files/:path{.+}/raw', '/files/a/b/raw'], ['/feed/:format?', '/feed'], ['/feed/:format?', '/feed/'], ['/feed/:format?', '/feed/rss'],
    ['/assets/*', '/assets'], ['/assets/*', '/assets/'], ['/assets/*', '/assets/a/b.css'],
    ['/wild/*/end', '/wild/x/end'], ['/wild/*/end', '/wild//end'], ['/wild/*/end', '/wild/x/y/end'], ['/wild/*/end', '/wild/x/other'],
    ['/p/:id.json', '/p/3.json'], ['/p/:id.json', '/p/3'], ['/p/:id-x/raw', '/p/3/raw'], ['/f/:name*', '/f/a'], ['/f/:name*', '/f/a/b'], ['/status/foo:bar', '/status/foo:bar'],
  ]

  test.each(HONO_CASES)('should agree with hono on %s against %s', async (route, path) => {
    const app = new Hono()
    app.get(route, (c) => c.text('ok'))
    const status = (await app.request(path)).status
    expect(routePathMatches(route, literal(path))).toBe(status === 200 ? 'match' : 'none')
  })

  test('should fill a lone parameter with a runtime segment, and nothing else', () => {
    const runtime: TestRequestSegment[] = [{ literal: 'posts' }, { runtime: true }]
    expect(routePathMatches('/posts/:id', runtime)).toBe('match')
    expect(routePathMatches('/posts/create', runtime)).toBe('none')
    expect(routePathMatches('/posts/:id.json', runtime)).toBe('match')
  })

  test('should read a runtime segment as filling a constrained parameter only when asked, and never a literal the constraint rejects', () => {
    const runtime: TestRequestSegment[] = [{ literal: 'posts' }, { runtime: true }]
    const fills = { runtimeFillsConstraints: true }
    expect(routePathMatches('/posts/:id{[0-9]+}', runtime)).toBe('unknown')
    expect(routePathMatches('/posts/:id{[0-9]+}', runtime, fills)).toBe('match')
    expect(routePathMatches('/posts/:id{[0-9]+}', [{ literal: 'posts' }, { literal: 'abc' }], fills)).toBe('none')
    expect(routePathMatches('/files/:path{.+}', [{ literal: 'files' }, { runtime: true }, { runtime: true }], fills)).toBe('unknown')
  })

  test('should answer unknown, never none, where a runtime segment meets a constraint or its span', () => {
    const RUNTIME = { runtime: true } as const
    const at = (...parts: Array<string | typeof RUNTIME>): TestRequestSegment[] => parts.map((part) => (typeof part === 'string' ? { literal: part } : part))
    expect(routePathMatches('/posts/:id{[0-9]+}', at('posts', RUNTIME))).toBe('unknown')
    expect(routePathMatches('/files/:path{.+}', at('files', 'a', RUNTIME))).toBe('unknown')
    expect(routePathMatches('/files/:path{.+}', at('files', RUNTIME, RUNTIME))).toBe('unknown')
    expect(routePathMatches('/files/:path{.+}/raw', at('files', RUNTIME, 'x', 'raw'))).toBe('unknown')
    expect(routePathMatches('/files/:path{.+}/raw', at('files', 'a', 'raw'))).toBe('match')
  })

  test('should answer unknown for a constraint it cannot compile', () => {
    expect(routePathMatches('/odd/:id{(}', literal('/odd/1'))).toBe('unknown')
  })
})

describe('routePathCovers', () => {
  /** Earlier route, later route, and requests the later one matches on its own. */
  const HONO_CASES: Array<[string, string, string[]]> = [
    ['/comments/:id', '/comments/new', ['/comments/new']],
    ['/comments/new', '/comments/:id', ['/comments/new', '/comments/7']],
    ['/comments/:comment', '/comments/:id', ['/comments/7']],
    ['/comments/*', '/comments/:id', ['/comments/7']],
    ['/posts/:id', '/posts/:id/edit', ['/posts/1/edit']],
    ['/posts/:id{[0-9]+}', '/posts/new', ['/posts/new']],
    ['/feed/:format?', '/feed', ['/feed']],
    ['/feed', '/feed/:format?', ['/feed', '/feed/rss']],
    ['/feed/:format', '/feed/:format?', ['/feed', '/feed/rss']],
    ['/:slug', '/', ['/']],
    ['/posts/', '/posts', ['/posts']],
  ]

  test.each(HONO_CASES)('should agree with hono on %s registered before %s', async (earlier, later, requests) => {
    const app = new Hono()
    app.get(earlier, (c) => c.text('earlier'))
    app.get(later, (c) => c.text('later'))
    const answers = await Promise.all(requests.map(async (path) => (await app.request(path)).text()))
    expect(routePathCovers(earlier, later)).toBe(answers.every((answer) => answer === 'earlier') ? 'match' : 'none')
  })

  test('should hand every request to the first route registered through the Router, an ALL route included', async () => {
    const router = new Router()
    router.on('ALL', '/comments/:id', (c) => c.text('earlier'))
    router.get('/comments/new', (c) => c.text('later'))
    const app = new Hono()
    router.mount(app)

    expect(router.definitions().map((route) => route.method)).toEqual(['ALL', 'GET'])
    expect(await (await app.request('/comments/new')).text()).toBe('earlier')
    expect(routePathCovers('/comments/:id', '/comments/new')).toBe('match')
  })

  test('should answer unknown, never match or none, where a constraint or a `*` meets what it cannot compare', () => {
    expect(routePathCovers('/posts/:id{[0-9]+}', '/posts/:slug')).toBe('unknown')
    expect(routePathCovers('/files/:name', '/files/:path{.+}')).toBe('unknown')
    expect(routePathCovers('/assets/:name', '/assets/*')).toBe('unknown')
    expect(routePathCovers('/odd/:id{(}', '/odd/:slug')).toBe('unknown')
    expect(routePathCovers('/posts/:id', '/archive/:year{[0-9]+}')).toBe('none')
  })
})

describe('the TestApp surface', () => {
  const TEST_APP_PATH = fileURLToPath(new URL('../../testing/src/test-app.ts', import.meta.url))

  /** Public instance members of `TestApp`, by the type name their return annotation spells. */
  async function membersReturning(): Promise<Record<string, string[]>> {
    const source = await readFile(TEST_APP_PATH, 'utf8')
    const ast = parseSourceFile(source, TEST_APP_PATH)
    if (!ast) throw new Error(`Could not parse ${TEST_APP_PATH}.`)
    for (const node of ast.program.body) {
      const declaration = extractClassDeclaration(node)
      if (declaration?.id?.name !== 'TestApp') continue
      const byType: Record<string, string[]> = {}
      for (const member of declaration.body.body) {
        if (member.type !== 'ClassMethod' || member.static || member.kind !== 'method' || member.accessibility === 'private') continue
        if (member.key.type !== 'Identifier') continue
        const annotation = member.returnType?.type === 'TSTypeAnnotation' ? member.returnType.typeAnnotation : undefined
        if (annotation?.type !== 'TSTypeReference' || annotation.typeName.type !== 'Identifier') continue
        const inner = annotation.typeParameters?.params[0]
        const type = annotation.typeName.name === 'Promise' && inner?.type === 'TSTypeReference' && inner.typeName.type === 'Identifier'
          ? inner.typeName.name
          : annotation.typeName.name
        ;(byType[type] ??= []).push(member.key.name)
      }
      return byType
    }
    throw new Error(`No 'TestApp' class declaration found in ${TEST_APP_PATH}.`)
  }

  test('should know every member that sends a request and every one that returns a TestApp', async () => {
    const byType = await membersReturning()
    expect(Object.keys(REQUEST_METHODS).sort()).toEqual([...byType.PendingTestResponse!].sort())
    expect([...BUILDERS].sort()).toEqual([...byType.TestApp!].sort())
  })
})
