import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, readFile, rm, symlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { generateAgentTypes } from '../src/agents-types'
import { agentToolRouteKey, joinRouteDefinitions } from '../src/app-routes'
import { runCheck, type CheckResult } from '../src/check'
import { generateContext, renderContextMarkdown } from '../src/context'
import { getDoctorRuleEvaluations } from '../src/doctor'
import { generateRouteTypes } from '../src/routes-types'
import { assertWorkspaceBuilt, captureWarnings, createTempRoot, linkWorkspaceCore, SERVER_DIST_ENTRY, writeWorkspaceFiles } from './helpers'

const repoRoot = resolve(import.meta.dir, '../../..')

const ENTRY = "import app from './app.js'\n\nexport default app\n"

/** A route the routes file never sees: registered by a provider, so only the introspected app has it. */
const HOOK_PROVIDER = `import { prototype, ServiceProvider, type Router } from '@guren/core'
import { z } from 'zod'

export default class HookRouteProvider extends ServiceProvider {
  register(): void {
    this.container.make<Router>('router')
      .get('/hooks/:hook', { params: z.object({ id: z.string() }) }, () => 'ok')
      .name('hooks.show')
      .agent({})
    this.container.make<Router>('router').get('/hooks/any/:id', { params: z.object({ id: z.string(), extra: z.any() }) }, () => 'ok')
    this.container.make<Router>('router').get('/hooks/draft', prototype).name('hooks.draft')
    this.container.make<Router>('router').get('/hooks/raw/:id', { params: z.any() }, () => 'ok')
  }
}
`

const THROWING_PROVIDER = `import { ServiceProvider } from '@guren/core'

export default class BindingProvider extends ServiceProvider {
  register(): void {
    throw new Error('env.DB is not bound outside workerd')
  }
}
`

const APP = (provider?: string) => `import { createApp } from '@guren/core'
${provider ? `import Provider from '../app/Providers/${provider}.js'\n` : ''}import { registerWebRoutes } from '../routes/web.js'

export default createApp({
  routes: registerWebRoutes,
  providers: [${provider ? 'Provider' : ''}],
  prototype: () => import('../resources/js/prototype/index.js'),
})
`

/**
 * One params schema per wrapper `permitsOmission()` classifies, each beside a stray key, so the
 * manifest's `required` and the routes file's Zod must agree on every severity. The walker drops
 * `z.any()` with a note and `z.undefined()` without one, and renders a nullable object as `anyOf`:
 * each leaves the manifest short of the schema, so the Zod decides.
 */
const ROUTES = `import { prototype, type Router } from '@guren/core'
import { z } from 'zod'
import PostController from '../app/Http/Controllers/PostController.js'

const withStray = (extra: z.ZodType) => z.object({ id: z.string(), extra })

export function registerWebRoutes(router: Router): void {
  router.get('/posts/:id', { params: withStray(z.string()) }, [PostController, 'show']).name('posts.show')
  router.post('/posts', [PostController, 'store']).name('posts.store').agent({})
  router.get('/draft', prototype).name('draft')
  router.get('/w/optional/:id', { params: withStray(z.string().optional()) }, () => 'ok')
  router.get('/w/default/:id', { params: withStray(z.string().default('a')) }, () => 'ok')
  router.get('/w/prefault/:id', { params: withStray(z.string().prefault('a')) }, () => 'ok')
  router.get('/w/catch/:id', { params: withStray(z.string().catch('a')) }, () => 'ok')
  router.get('/w/nonoptional/:id', { params: withStray(z.string().optional().nonoptional()) }, () => 'ok')
  router.get('/w/pipe/:id', { params: withStray(z.string().pipe(z.string())) }, () => 'ok')
  router.get('/w/pipe-optional/:id', { params: withStray(z.string().optional().pipe(z.string().optional())) }, () => 'ok')
  router.get('/w/any/:id', { params: withStray(z.any()) }, () => 'ok')
  router.get('/w/nullable/:id', { params: withStray(z.string()).nullable() }, () => 'ok')
  router.get('/w/undefined/:id', { params: withStray(z.undefined()) }, () => 'ok')
  router.get('/w/query-any/:id', { params: withStray(z.string()), query: z.object({ q: z.any() }) }, () => 'ok')
}
`

const POST_CONTROLLER = `import { Controller } from '@guren/core'

export default class PostController extends Controller {
  async show() {
    return this.json({})
  }

  async store() {
    return this.json(await this.input())
  }
}
`

/** 'hooks.show' names the provider's route: an orphan only to a check that cannot see it. */
const PROTOTYPE_FIXTURE = `import { definePrototype, page } from '@guren/inertia-client/prototype'

export default definePrototype({
  manifest: {},
  routes: {
    'draft': () => page('Draft', {}),
    'hooks.show': () => page('Hook', {}),
  },
})
`

let root: string

/** One directory per scenario: `introspectApp()` memoises per app root for the whole test process. */
async function scaffoldApp(name: string, files: Record<string, string> = {}): Promise<string> {
  const dir = join(root, name)
  await linkWorkspaceCore(dir)
  const zodLink = join(dir, 'node_modules', 'zod')
  await mkdir(dirname(zodLink), { recursive: true })
  await symlink(join(repoRoot, 'node_modules', 'zod'), zodLink, 'dir')
  await writeWorkspaceFiles(dir, {
    // Bun otherwise installs an unresolvable specifier from npm instead of failing.
    'bunfig.toml': '[install]\nauto = "disable"\n',
    'package.json': JSON.stringify({ name, type: 'module' }),
    'src/main.ts': ENTRY,
    'src/app.ts': APP(),
    'routes/web.ts': ROUTES,
    'app/Http/Controllers/PostController.ts': POST_CONTROLLER,
    'resources/js/prototype/index.ts': PROTOTYPE_FIXTURE,
    ...files,
  })
  return dir
}

const ROUTE_RULES = /^(route-contract|agent-route|prototype-|introspection-)/

async function routeChecks(dir: string, introspect: boolean): Promise<Record<string, CheckResult>> {
  const report = await runCheck({ cwd: dir, introspect })
  return Object.fromEntries(report.checks.filter((result) => ROUTE_RULES.test(result.key)).map((result) => [result.key, result]))
}

let withProvider: string
let manifest: Record<string, CheckResult>
let source: Record<string, CheckResult>

beforeAll(async () => {
  assertWorkspaceBuilt([SERVER_DIST_ENTRY])
  root = await createTempRoot('guren-route-introspect-test-')
  withProvider = await scaffoldApp('provider', {
    'src/app.ts': APP('HookRouteProvider'),
    'app/Providers/HookRouteProvider.ts': HOOK_PROVIDER,
  })
  manifest = await routeChecks(withProvider, true)
  source = await routeChecks(withProvider, false)
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

/** The keys both paths judge, and the provider's route, which only the manifest path sees. */
const HOOK_KEY = 'route-contract-params:GET:/hooks/:hook'

describe('guren check route rules against the introspected app (RFC 0026 §5, Part 2d)', () => {
  test('judges the routes the routes file registers the same way on both paths', () => {
    const shared = Object.keys(source).filter((key) => key in manifest)
    expect(shared.length).toBeGreaterThan(10)
    // An app-wide summary names the provider's route too.
    const appWide = 'prototype-pages-unreachable'
    for (const key of shared.filter((key) => key !== appWide)) {
      const { status, message } = manifest[key]!
      expect({ key, status, message }).toEqual({ key, status: source[key]!.status, message: source[key]!.message })
    }
    expect(manifest[appWide]!.message).toContain('hooks.draft, posts.show')
    expect(source[appWide]!.message).toContain(': posts.show.')
    expect(Object.keys(source).filter((key) => !(key in manifest))).toEqual(['prototype-fixture-orphan:hooks.show'])
  })

  test('reads params keys and their severity from the manifest, and says so', () => {
    expect(manifest['route-contract-params:GET:/posts/:id']).toMatchObject({ status: 'fail', evidence: 'manifest' })
    expect(source['route-contract-params:GET:/posts/:id']).toMatchObject({ status: 'fail', evidence: 'static' })
    const severity = (checks: Record<string, CheckResult>, wrapper: string) =>
      [`route-contract-params:GET:/w/${wrapper}/:id`, `route-contract-params-optional:GET:/w/${wrapper}/:id`].find((key) => key in checks)
    for (const wrapper of ['optional', 'default', 'prefault', 'catch', 'nonoptional', 'pipe', 'pipe-optional']) {
      expect({ wrapper, key: severity(manifest, wrapper) }).toEqual({ wrapper, key: severity(source, wrapper) })
      expect(manifest[severity(manifest, wrapper)!]?.evidence).toBe('manifest')
    }
  })

  test('keeps a params schema on the manifest when only another segment renders short', () => {
    expect(manifest['route-contract-params:GET:/w/query-any/:id']).toMatchObject({ status: 'fail', evidence: 'manifest' })
  })

  test('falls back to the Zod for a params schema the manifest renders short', () => {
    for (const path of ['/w/any/:id', '/w/nullable/:id', '/w/undefined/:id']) {
      expect(manifest[`route-contract-params:GET:${path}`]).toMatchObject({ status: 'fail', evidence: 'static' })
    }
  })

  test('judges a route a provider registers, which the routes file cannot show', () => {
    expect(manifest[HOOK_KEY]).toMatchObject({ status: 'fail', evidence: 'manifest' })
    expect(source[HOOK_KEY]).toBeUndefined()
    // No Zod to fall back to, and the walker dropped a key: unreadable, never a pass.
    expect(manifest['route-contract-params:GET:/hooks/any/:id']).toMatchObject({ status: 'warn', evidence: 'manifest' })
    expect(manifest['route-contract-params:GET:/hooks/any/:id']!.message).toContain('renders the params schema only in part')
    // A schema the walker cannot render at all: its note, then the rest, with no doubled stop.
    expect(manifest['route-contract-params:GET:/hooks/raw/:id']).toMatchObject({ status: 'warn', evidence: 'manifest' })
    expect(manifest['route-contract-params:GET:/hooks/raw/:id']!.message).toMatch(/unsupported Zod type "any", and the routes file registers no route/u)
    expect(manifest['agent-route-output:GET:/hooks/:hook']).toMatchObject({ status: 'warn', evidence: 'manifest' })
    expect(manifest['prototype-fixture-orphan:hooks.show']).toBeUndefined()
    expect(source['prototype-fixture-orphan:hooks.show']).toMatchObject({ status: 'fail', evidence: 'static' })
  })

  test('marks a verdict read from a controller body as source, whichever path supplied the route', () => {
    expect(manifest['agent-route-authorization:POST:/posts']).toMatchObject({ status: 'fail', evidence: 'static' })
    expect(manifest['agent-route-input:POST:/posts']).toMatchObject({ status: 'warn', evidence: 'manifest' })
    expect(manifest['prototype-app-wiring']).toMatchObject({ status: 'pass', evidence: 'static' })
  })

  test('judges from the routes file after a provider threw, naming it', async () => {
    const dir = await scaffoldApp('threw', {
      'src/app.ts': APP('BindingProvider'),
      'app/Providers/BindingProvider.ts': THROWING_PROVIDER,
    })
    const checks = await routeChecks(dir, true)
    expect(checks['route-contract-params:GET:/posts/:id']).toMatchObject({ status: 'fail', evidence: 'static' })
    expect(checks['route-contract-params:GET:/posts/:id']!.message).toContain('Judged from source: BindingProvider threw in register()')
    expect(checks['introspection-unavailable']).toBeUndefined()
  })

  test('judges from the routes file when the app cannot be introspected, and reports it once', async () => {
    const dir = await scaffoldApp('broken', { 'src/main.ts': "import app from './app.js'\nimport './missing-module.js'\n\nexport default app\n" })
    const checks = await routeChecks(dir, true)
    expect(checks['route-contract-params:GET:/posts/:id']).toMatchObject({ status: 'fail', evidence: 'static' })
    expect(checks['introspection-unavailable']).toMatchObject({ status: 'warn', advisory: true })

    const context = await generateContext({ cwd: dir, introspect: true })
    expect(context.routesNotIntrospected).toContain('could not be introspected (import)')
    expect(renderContextMarkdown(context)).toContain('Not introspected: The app could not be introspected (import)')
    expect((await generateContext({ cwd: dir, introspect: false })).routesNotIntrospected).toBeUndefined()

    const { evaluations } = await getDoctorRuleEvaluations({ cwd: dir, introspect: true })
    const rule = evaluations.find(({ check }) => check.key === 'prototype-routes')?.check
    expect(rule).toMatchObject({ status: 'fail', evidence: 'static' })
    expect(rule?.evidenceReason).toContain('introspection failed with import')
  })

  test('reads the routes file for a --routes run: the manifest describes the entry', async () => {
    const checks = Object.fromEntries((await runCheck({ cwd: withProvider, introspect: true, routesFile: 'routes/web.ts' })).checks.map((result) => [result.key, result]))
    expect(checks[HOOK_KEY]).toBeUndefined()
    expect(checks['route-contract-params:GET:/posts/:id']?.message).toContain('--routes names a routes file')
  })
})

/** Each trigger on its own: a routes file whose only contract is a `bind`, and whose only agent route is inline. */
const TRIGGER_ROUTES = `import type { Router } from '@guren/core'

class Post {
  static async findOrFail(): Promise<unknown> {
    return {}
  }
}

export function registerWebRoutes(router: Router): void {
  router.get('/p/:id', { bind: { post: Post } }, () => 'ok')
  router.post('/tasks', () => 'ok').name('tasks.run').agent({})
}
`

/** Registered before the routes file, so its \`tasks.run\` is the tool the running app exposes. */
const TRIGGER_PROVIDER = `import { ServiceProvider, type Router } from '@guren/core'
import { z } from 'zod'

export default class HookRouteProvider extends ServiceProvider {
  register(): void {
    const router = this.container.make<Router>('router')
    router.post('/hooks/run', { body: z.object({ note: z.string() }) }, () => 'ok').name('tasks.run').agent({})
    router.get('/hooks/:hook', { params: z.object({ id: z.string() }) }, () => 'ok')
  }
}
`

/** The app's only agent tool comes from a provider: the routes file derives none. */
const TOOL_PROVIDER = `import { ServiceProvider, type Router } from '@guren/core'

export default class HookRouteProvider extends ServiceProvider {
  register(): void {
    this.container.make<Router>('router').post('/hooks/ping', () => 'ok').name('hooks.ping').agent({})
  }
}
`

describe('the rules each start the introspection on their own content', () => {
  test('a binding alone starts the route contracts, an inline agent route alone the agent-route rules', async () => {
    const dir = await scaffoldApp('triggers', {
      'src/app.ts': APP('HookRouteProvider'),
      'app/Providers/HookRouteProvider.ts': TRIGGER_PROVIDER,
      'routes/web.ts': TRIGGER_ROUTES,
    })
    const checks = await routeChecks(dir, true)
    expect(checks['route-contract-bind:GET:/p/:id']).toMatchObject({ status: 'fail', evidence: 'manifest' })
    expect(checks['route-contract-params:GET:/hooks/:hook']).toMatchObject({ status: 'fail', evidence: 'manifest' })
    expect(checks['agent-route-duplicate:tasks.run']).toMatchObject({ status: 'fail', evidence: 'manifest' })
  })

  test('codegen --introspect keeps the tool the running app exposes when two routes claim one name', async () => {
    const dir = await scaffoldApp('triggers-codegen', {
      'src/app.ts': APP('HookRouteProvider'),
      'app/Providers/HookRouteProvider.ts': TRIGGER_PROVIDER,
      'routes/web.ts': TRIGGER_ROUTES,
    })
    const { result } = await captureWarnings(() => generateRouteTypes({ appRoot: dir, introspect: true, outputFile: 'out/routes.d.ts', runtimeOutputFile: 'out/routes.gen.ts' }))
    const { tools } = await generateAgentTypes(result.definitions, { appRoot: dir, outputFile: 'out/agents.gen.ts' })
    expect(tools.map((tool) => `${tool.toolName} ${tool.method} ${tool.path}`)).toEqual(['tasks.run POST /hooks/run'])
    // The schema only the manifest carries: the routes file has no Zod for this route.
    expect(Object.keys(tools[0]!.inputSchema.properties ?? {})).toEqual(['note'])
  })
})

describe('agentToolRouteKey', () => {
  test('tells apart two routes on one method, path and name that differ in agent.toolName', () => {
    expect(agentToolRouteKey('post', '/a', 'a.run', 'first')).not.toBe(agentToolRouteKey('POST', '/a', 'a.run', 'second'))
    expect(agentToolRouteKey('post', '/a', 'a.run', undefined)).toBe(agentToolRouteKey('POST', '/a', 'a.run', 'a.run'))
  })
})

describe('an app whose agent tools come only from a provider', () => {
  test('codegen --introspect writes them, check and doctor call the file stale, and codegen without the flag removes it', async () => {
    const dir = await scaffoldApp('provider-tools', {
      'src/app.ts': APP('HookRouteProvider'),
      'app/Providers/HookRouteProvider.ts': TOOL_PROVIDER,
      // The params schema starts the route rules' introspection, so the stale verdict is an introspected run's.
      'routes/web.ts': "import type { Router } from '@guren/core'\nimport { z } from 'zod'\n\nexport function registerWebRoutes(router: Router): void {\n  router.get('/health/:id', { params: z.object({ id: z.string() }) }, () => 'ok').name('health')\n}\n",
    })
    const manifestFile = join(dir, '.guren/agents.gen.ts')
    const codegenBoth = async (introspect: boolean) => {
      const { result } = await captureWarnings(() => generateRouteTypes({ appRoot: dir, introspect, force: true }))
      return (await generateAgentTypes(result.definitions, { appRoot: dir, force: true })).tools.map((tool) => tool.toolName)
    }

    expect(await codegenBoth(true)).toContain('hooks.ping')
    expect(await readFile(manifestFile, 'utf8')).toContain('hooks.ping')

    const staleKey = 'manifest:.guren/agents.gen.ts'
    const report = await runCheck({ cwd: dir, introspect: true })
    expect(report.checks.find((result) => result.key === 'route-contracts')).toMatchObject({ status: 'pass', evidence: 'manifest' })
    const checked = report.checks.find((result) => result.key === staleKey)
    expect(checked).toMatchObject({ status: 'warn' })
    expect(checked!.message).toContain('codegen --introspect')
    const { evaluations } = await getDoctorRuleEvaluations({ cwd: dir, introspect: true })
    expect(evaluations.find(({ check }) => check.key === 'generated:.guren/agents.gen.ts')?.check.message).toContain('codegen --introspect')

    expect(await codegenBoth(false)).not.toContain('hooks.ping')
    expect(await readFile(manifestFile, 'utf8').catch(() => null)).toBeNull()
  })
})

describe('joinRouteDefinitions', () => {
  const route = (method: string, path: string, name?: string) => ({ method, path, ...(name ? { name } : {}) })

  test('pairs repeats nth to nth, whatever the method\'s case', () => {
    const definitions = [route('GET', '/a', 'first'), route('get', '/b'), route('GET', '/b')]
    expect(joinRouteDefinitions([route('GET', '/b'), route('get', '/a', 'first'), route('GET', '/b')], definitions))
      .toEqual([definitions[1], definitions[0], definitions[2]])
  })

  test('matches nothing for a key the two sides count differently, and a route the routes file lacks', () => {
    expect(joinRouteDefinitions([route('GET', '/b'), route('GET', '/b'), route('GET', '/c')], [route('GET', '/b')]))
      .toEqual([undefined, undefined, undefined])
  })

  test('tells two routes on one path apart by controller action', () => {
    const show = { ...route('GET', '/p'), controller: { name: 'P', action: 'show' } }
    const index = { ...route('GET', '/p'), controller: { name: 'P', action: 'index' } }
    expect(joinRouteDefinitions([index, show], [show, index])).toEqual([index, show])
  })

  test('joins a key two modules share within its module when the definitions carry theirs', () => {
    const blog = { ...route('POST', '/posts'), module: 'blog' }
    const billing = { ...route('POST', '/posts'), module: 'billing' }
    const definitions = [{ ...route('POST', '/posts'), module: 'billing' }, { ...route('POST', '/posts'), module: 'blog' }]
    expect(joinRouteDefinitions([blog, billing], definitions, { byModule: true })).toEqual([definitions[1], definitions[0]])
    expect(joinRouteDefinitions([blog, billing], definitions)).toEqual([definitions[0], definitions[1]])
  })

  test('joins no route whose module the manifest does not list', () => {
    expect(joinRouteDefinitions([{ ...route('GET', '/a'), module: null }], [{ ...route('GET', '/a'), module: 'billing' }], { byModule: true }))
      .toEqual([undefined])
  })
})

describe('guren doctor prototype-routes against the introspected app', () => {
  test('counts the routes on the fixture from the manifest, and from the routes file without it', async () => {
    const [introspected, fromSource] = await Promise.all([
      getDoctorRuleEvaluations({ cwd: withProvider, introspect: true }),
      getDoctorRuleEvaluations({ cwd: withProvider, introspect: false }),
    ])
    const rule = (report: typeof introspected) => report.evaluations.find(({ check }) => check.key === 'prototype-routes')?.check
    expect(rule(introspected)).toMatchObject({ status: 'fail', evidence: 'manifest' })
    expect(rule(fromSource)).toMatchObject({ status: 'fail', evidence: 'static' })
    expect(rule(introspected)!.message).toContain('2 route(s)')
    expect(rule(introspected)!.message).toContain('GET /hooks/draft (hooks.draft)')
    expect(rule(fromSource)!.message).toContain('1 route(s)')
  })
})

describe('guren context against the introspected app', () => {
  test('lists a provider\'s route too, and every other route exactly as the routes file renders it', async () => {
    const [introspected, fromSource] = await Promise.all([
      generateContext({ cwd: withProvider, introspect: true }),
      generateContext({ cwd: withProvider, introspect: false }),
    ])
    const hook = introspected.routes.find((route) => route.path === '/hooks/:hook')
    expect(hook).toMatchObject({ method: 'GET', name: 'hooks.show', agent: {} })
    expect(hook?.params).toBeUndefined()
    expect(fromSource.routes.some((route) => route.path === '/hooks/:hook')).toBe(false)

    const rest = { ...introspected, routes: introspected.routes.filter((route) => !route.path.startsWith('/hooks/')) }
    expect(renderContextMarkdown(rest)).toBe(renderContextMarkdown(fromSource))
    expect(JSON.stringify(rest)).toBe(JSON.stringify(fromSource))
  })

  test('reads the routes file under --routes', async () => {
    const context = await generateContext({ cwd: withProvider, introspect: true, routesFile: 'routes/web.ts' })
    expect(context.routes.some((route) => route.path === '/hooks/:hook')).toBe(false)
  })
})

describe('guren codegen --introspect', () => {
  async function codegen(dir: string, introspect: boolean, out: string) {
    const { result, warnings } = await captureWarnings(() => generateRouteTypes({
      appRoot: dir,
      introspect,
      outputFile: `${out}/routes.d.ts`,
      runtimeOutputFile: `${out}/routes.gen.ts`,
    }))
    const agents = await generateAgentTypes(result.definitions, { appRoot: dir, outputFile: `${out}/agents.gen.ts` })
    const read = (file: string) => readFile(join(dir, out, file), 'utf8')
    return { warnings, tools: agents.tools.map((tool) => tool.toolName).sort(), files: await Promise.all(['routes.d.ts', 'routes.gen.ts', 'agents.gen.ts'].map(read)) }
  }

  test('writes byte for byte what the routes file does when the app registers no other route', async () => {
    const dir = await scaffoldApp('plain')
    const [introspected, fromSource] = [await codegen(dir, true, 'out-introspect'), await codegen(dir, false, 'out-static')]
    expect(introspected.files).toEqual(fromSource.files)
    expect(introspected.warnings).toEqual([])
  })

  test('adds a provider\'s route, and its agent tool from the manifest', async () => {
    const [introspected, fromSource] = [await codegen(withProvider, true, 'out-introspect'), await codegen(withProvider, false, 'out-static')]
    expect(introspected.files[1]).toContain("'hooks.show': { method: 'GET', path: '/hooks/:hook' }")
    expect(fromSource.files[1]).not.toContain('hooks.show')
    expect(introspected.tools).toEqual(['hooks.show', 'posts.store'])
    expect(fromSource.tools).toEqual(['posts.store'])
    expect(introspected.warnings.join('\n')).toContain('GET /hooks/:hook')
  })

  test('falls back to the routes file when the app cannot be introspected, saying why', async () => {
    const dir = await scaffoldApp('codegen-broken', { 'src/main.ts': "import app from './app.js'\nimport './missing-module.js'\n\nexport default app\n" })
    const introspected = await codegen(dir, true, 'out-introspect')
    expect(introspected.files).toEqual((await codegen(dir, false, 'out-static')).files)
    expect(introspected.warnings.join('\n')).toContain('could not be introspected (import)')
  })
})
