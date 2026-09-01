import { describe, expect, test, afterEach } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { Controller, Router, deriveAgentTools, type RouteDefinition } from '@guren/core'
import { authorizeMiddleware } from '@guren/core'
import {
  checkTypes,
  GENERATED_MODULE_COMPILER_OPTIONS,
  linkWorkspaceCore,
  TSC_TIMEOUT,
  writeWorkspaceFiles,
} from './helpers'
import {
  AGENTS_MANIFEST_FILE,
  appDeclaresAgentRoutes,
  buildAgentToolsContent,
  generateAgentTypes,
  planAgentManifest,
  type AgentResourceRef,
} from '../src/agents-types'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

async function makeApp(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'guren-agents-types-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  await writeWorkspaceFiles(dir, files)
  return dir
}

/**
 * Stands in for a JsonResource subclass: the router serializes a `resource`
 * hint by reading the class's `name`, so a real class is what makes the hint
 * survive `definitions()` as `'ArticleResource'`.
 */
class ArticleResource {
  toJSON(): unknown {
    return {}
  }
}

class PostController extends Controller {
  async index() {
    return this.json({ posts: [] })
  }

  async store() {
    return this.created({})
  }
}

/**
 * A router carrying the shapes this generator has to describe: a read-only
 * list with a `resource` hint, an authorized write with a body schema, and a
 * route with an `output` schema that outranks its hint.
 */
function fixtureDefinitions(): RouteDefinition[] {
  const router = new Router()
  router.get(
    '/posts',
    { name: 'posts.index', resource: { data: [ArticleResource] }, description: 'List posts.' },
    [PostController, 'index'],
  ).agent({})
  router
    .post('/posts/:id', { name: 'posts.store', body: z.object({ title: z.string().min(1) }) }, [
      PostController,
      'store',
    ])
    .middleware(authorizeMiddleware('create-post'))
    .agent({ description: 'Create a post.', approval: 'required', redact: ['token'] })
  router.get(
    '/posts/summary',
    {
      name: 'posts.summary',
      output: z.object({ total: z.number() }),
      resource: ArticleResource,
      agent: {},
    },
    [PostController, 'index'],
  )
  router.get('/hidden', [PostController, 'index']).name('hidden.index')
  return router.definitions()
}

const resources: AgentResourceRef[] = [
  {
    className: 'ArticleResource',
    dataName: 'Article',
    rawType: '{ id: number; title: string }',
    filePath: 'app/Http/Resources/ArticleResource.ts',
  },
]

const DATA_GEN = `export namespace Data {
  export type Article = { id: number; title: string }
}
`

describe('buildAgentToolsContent', () => {
  test('emits one entry per derived tool, keyed by tool name', () => {
    const { tools } = deriveAgentTools(fixtureDefinitions())
    const content = buildAgentToolsContent(tools, { resources })

    expect(content).toContain("'posts.index': {")
    expect(content).toContain("'posts.store': {")
    expect(content).toContain("'posts.summary': {")
    expect(content).not.toContain("'hidden.index'")
    expect(content).toContain('} as const')
  })

  test('carries the merged input schema, annotations and authorization', () => {
    const { tools } = deriveAgentTools(fixtureDefinitions())
    const content = buildAgentToolsContent(tools, { resources })

    expect(content).toContain('"minLength": 1')
    expect(content).toContain('"id"')
    expect(content).toContain('"readOnlyHint": false')
    expect(content).toContain('ability": "create-post"')
    expect(content).toContain('approval: "required"')
    expect(content).toContain('"token"')
  })

  test('carries the merge inverse a client needs to rebuild the request', () => {
    const { tools } = deriveAgentTools(fixtureDefinitions())
    const content = buildAgentToolsContent(tools, { resources })

    // posts.store is POST /posts/:id with an object body: `id` substitutes
    // into the path, `title` rides in the JSON body. Without these fields a
    // client can only guess by method, and would post `id` in the body of a
    // route whose URL cannot be built without it.
    expect(content).toContain('"id": "path"')
    expect(content).toContain('"title": "body"')
    expect(content).toContain('inputBodyNested: false')
  })

  test('marks a non-object body as nested', () => {
    const router = new Router()
    router
      .post('/posts/bulk', { name: 'posts.bulk', body: z.array(z.string()) }, [
        PostController,
        'store',
      ])
      .agent({})
    const { tools } = deriveAgentTools(router.definitions())
    const content = buildAgentToolsContent(tools)

    // The derivation nested the array under `body` to give the tool an object
    // root; a client that missed this flag would post `{ body: [...] }` to a
    // route that validates the array itself.
    expect(content).toContain('inputBodyNested: true')
    expect(content).toContain('"body": "body"')
  })

  test('embeds a resource hint’s type text in the description and references Data', () => {
    const { tools } = deriveAgentTools(fixtureDefinitions())
    const content = buildAgentToolsContent(tools, { resources })

    expect(content).toContain("import type { Data } from './data.gen'")
    expect(content).toContain('Returns: { data: Array<{ id: number; title: string }> }')
    expect(content).toContain("'posts.index': { data: Array<Data.Article> }")
  })

  test('leaves a route with an output schema to that schema alone', () => {
    const { tools } = deriveAgentTools(fixtureDefinitions())
    const content = buildAgentToolsContent(tools, { resources })

    // posts.summary declares both; the validated schema wins, so no type text
    // is appended and no output-type entry is emitted for it.
    expect(content).not.toContain("'posts.summary': Data.Article")
    expect(content).toContain('"total"')
  })

  test('warns and leaves the response undescribed when a hint names an unknown class', () => {
    const { tools } = deriveAgentTools(fixtureDefinitions())
    const warnings: string[] = []
    const content = buildAgentToolsContent(tools, { resources: [], warnings })

    expect(warnings.some((warning) => warning.includes('ArticleResource'))).toBe(true)
    expect(content).not.toContain('Returns:')
    expect(content).not.toContain("import type { Data }")
  })

  test('omits the Data import when nothing resolves against it', () => {
    const router = new Router()
    router.get('/posts', [PostController, 'index']).name('posts.index').agent({})
    const { tools } = deriveAgentTools(router.definitions())

    const content = buildAgentToolsContent(tools)
    expect(content).not.toContain("from './data.gen'")
    expect(content).toContain('No tool declares a resolvable resource response hint.')
  })

  test('emits a __proto__ property as a computed key, in every map keyed by argument name', async () => {
    const router = new Router()
    router.get('/posts/:__proto__', [PostController, 'index']).name('posts.odd').agent({})
    const { tools } = deriveAgentTools(router.definitions())

    const content = buildAgentToolsContent(tools)
    // A quoted `"__proto__":` key in an object literal sets [[Prototype]]
    // instead of defining a property, so the manifest would describe a tool
    // argument that is not there.
    expect(content).toContain('["__proto__"]:')
    expect(content).not.toContain('"__proto__":')

    // Evaluated rather than matched, because two maps are keyed by argument
    // name now — `inputSchema.properties` and `inputSources` — and a string
    // assertion passes as soon as *one* of them uses the computed form.
    const dir = await makeApp()
    const modulePath = join(dir, 'proto-property.gen.mjs')
    await writeFile(modulePath, new Bun.Transpiler({ loader: 'ts' }).transformSync(content), 'utf8')
    const { agentTools } = (await import(modulePath)) as {
      agentTools: Record<string, { inputSchema: { properties: object }; inputSources: object }>
    }

    const tool = agentTools['posts.odd']!
    expect(Object.hasOwn(tool.inputSchema.properties, '__proto__')).toBe(true)
    expect(Object.hasOwn(tool.inputSources, '__proto__')).toBe(true)
  })

  test('emits a tool named __proto__ as a computed key, and it survives evaluation', async () => {
    const router = new Router()
    // A legal tool name: the MCP grammar is ^[A-Za-z0-9._-]{1,128}$, and tool
    // names are route names verbatim.
    router.get('/posts', [PostController, 'index']).name('__proto__').agent({})
    const { tools } = deriveAgentTools(router.definitions())

    const content = buildAgentToolsContent(tools)
    expect(content).toContain("['__proto__']: {")
    expect(content).not.toContain("  '__proto__': {")

    // Evaluated, not merely matched: with a plain-string key here the entry
    // sets [[Prototype]] and the tool disappears from the manifest that
    // appears to declare it.
    const dir = await makeApp()
    const modulePath = join(dir, 'agents.gen.mjs')
    await writeFile(modulePath, new Bun.Transpiler({ loader: 'ts' }).transformSync(content), 'utf8')
    const { agentTools } = (await import(modulePath)) as { agentTools: Record<string, unknown> }

    expect(Object.keys(agentTools)).toEqual(['__proto__'])
    expect(Object.hasOwn(agentTools, '__proto__')).toBe(true)
  })

  test(
    'emits a module that type-checks beside data.gen.ts',
    async () => {
      const dir = await makeApp()
      const { tools } = deriveAgentTools(fixtureDefinitions())
      const modulePath = join(dir, 'agents.gen.ts')
      await Promise.all([
        writeFile(modulePath, buildAgentToolsContent(tools, { resources }), 'utf8'),
        writeFile(join(dir, 'data.gen.ts'), DATA_GEN, 'utf8'),
      ])

      expect(checkTypes([modulePath], GENERATED_MODULE_COMPILER_OPTIONS)).toEqual([])
    },
    TSC_TIMEOUT,
  )
})

describe('generateAgentTypes', () => {
  test('writes the manifest for an app whose routes declare agent metadata', async () => {
    const dir = await makeApp()

    const { outputPath, tools, warnings } = await generateAgentTypes(fixtureDefinitions(), {
      appRoot: dir,
      resources,
    })

    expect(warnings).toEqual([])
    expect(tools.map((tool) => tool.toolName).sort()).toEqual(['posts.index', 'posts.store', 'posts.summary'])
    expect(outputPath).toBe(join(dir, AGENTS_MANIFEST_FILE))
    expect(await readFile(outputPath, 'utf8')).toContain('export const agentTools')
  })

  test('writes nothing, and removes a stale manifest, when no route declares agent metadata', async () => {
    const dir = await makeApp({ '.guren/agents.gen.ts': '// stale\n' })

    const router = new Router()
    router.get('/posts', [PostController, 'index']).name('posts.index')
    const { outputPath, tools } = await generateAgentTypes(router.definitions(), { appRoot: dir })

    // An empty path is the "nothing to describe" signal the MCP codegen tool
    // reads; a stale manifest describing tools the app no longer exposes is
    // worse than none.
    expect(outputPath).toBe('')
    expect(tools).toEqual([])
    expect(existsSync(join(dir, AGENTS_MANIFEST_FILE))).toBe(false)
  })

  test('reports derivation warnings to its caller', async () => {
    const dir = await makeApp()
    const router = new Router()
    router.get('/posts', [PostController, 'index']).agent({ description: 'List posts' })

    const { warnings } = await generateAgentTypes(router.definitions(), { appRoot: dir })
    expect(warnings[0]).toContain('no route name')
  })
})

describe('planAgentManifest', () => {
  const AGENT_ROUTES = `import { Router } from '@guren/core'

export function registerWebRoutes(router: Router): void {
  router.get('/posts', () => 'posts').name('posts.index').agent({})
}

export default registerWebRoutes
`

  const NO_AGENT_ROUTES = `import { Router } from '@guren/core'

export function registerWebRoutes(router: Router): void {
  router.get('/posts', () => 'posts').name('posts.index')
}

export default registerWebRoutes
`

  // An .agent() route that cannot become a tool: no .name(). The string scan
  // says "agent routes here", the derivation says "no tools" — the
  // disagreement that used to strand check and doctor in a loop.
  const UNNAMED_AGENT_ROUTE = `import { Router } from '@guren/core'

export function registerWebRoutes(router: Router): void {
  router.get('/posts', () => 'posts').agent({ description: 'List posts' })
}

export default registerWebRoutes
`

  async function makeLinkedApp(files: Record<string, string>): Promise<string> {
    const dir = await makeApp(files)
    await linkWorkspaceCore(dir)
    return dir
  }

  test('expects a manifest when the derivation yields a tool', async () => {
    const dir = await makeLinkedApp({ 'routes/web.ts': AGENT_ROUTES })

    expect(await planAgentManifest(dir)).toEqual({ reason: 'tools', toolCount: 1, staleManifest: false })
  })

  test('expects none when no route declares agent metadata, without loading the app', async () => {
    // The routes file throws on import, so a plan that comes back cleanly is
    // proof the derivation was never attempted — the cheap path an app with
    // no manifest and no `.agent()` in its sources must keep.
    const dir = await makeLinkedApp({
      'routes/web.ts': `throw new Error('the route graph must not be loaded here')\n`,
    })

    expect(await planAgentManifest(dir)).toEqual({ reason: 'no-tools', toolCount: 0, staleManifest: false })
  })

  test('expects none — and reports a stale file — when .agent() derives no tool', async () => {
    const dir = await makeLinkedApp({
      'routes/web.ts': UNNAMED_AGENT_ROUTE,
      '.guren/agents.gen.ts': '// left over\n',
    })

    // The remedy both check and doctor print is `guren codegen`, which removes
    // the file. Expecting one here instead would print a remedy that deletes
    // what it just demanded.
    expect(await planAgentManifest(dir)).toEqual({ reason: 'no-tools', toolCount: 0, staleManifest: true })
  })

  test('reports a manifest left behind after the last .agent() was removed', async () => {
    const dir = await makeLinkedApp({
      'routes/web.ts': NO_AGENT_ROUTES,
      '.guren/agents.gen.ts': '// left over\n',
    })

    // Reached despite the string scan saying "no agent routes": a file on disk
    // is itself reason enough to ask the derivation.
    expect(await planAgentManifest(dir)).toEqual({ reason: 'no-tools', toolCount: 0, staleManifest: true })
  })

  test('claims nothing when the route graph cannot be loaded', async () => {
    // Mentions agent metadata, so the cheap path does not apply — and then
    // fails to load. Neither "expected" nor "stale" would be honest.
    const dir = await makeLinkedApp({
      'routes/web.ts': `// .agent(\nthrow new Error('boom')\n`,
    })

    const plan = await planAgentManifest(dir)
    expect(plan.reason).toBe('unreadable')
    expect(plan.staleManifest).toBe(false)
    expect(plan.loadError).toContain('boom')
  })

  test('treats a missing routes file as nothing to derive', async () => {
    const dir = await makeApp({ '.guren/agents.gen.ts': '// left over\n' })

    expect(await planAgentManifest(dir)).toEqual({ reason: 'no-tools', toolCount: 0, staleManifest: true })
  })
})

describe('appDeclaresAgentRoutes', () => {
  test('sees the fluent builder call', async () => {
    const dir = await makeApp({
      'routes/web.ts': `import { Router } from '@guren/core'

export function registerWebRoutes(router: Router): void {
  router.get('/posts', () => 'posts').name('posts.index').agent({})
}
`,
    })

    expect(await appDeclaresAgentRoutes(dir)).toBe(true)
  })

  test('sees the route-contract option key', async () => {
    const dir = await makeApp({
      'routes/web.ts': `import { Router } from '@guren/core'

export function registerWebRoutes(router: Router): void {
  router.get('/posts', { name: 'posts.index', agent: {} }, () => 'posts')
}
`,
    })

    expect(await appDeclaresAgentRoutes(dir)).toBe(true)
  })

  test('is false for an app whose routes declare none', async () => {
    const dir = await makeApp({
      'routes/web.ts': `import { Router } from '@guren/core'

export function registerWebRoutes(router: Router): void {
  router.get('/posts', () => 'posts').name('posts.index')
}
`,
    })

    expect(await appDeclaresAgentRoutes(dir)).toBe(false)
  })

  test('scans module routes too', async () => {
    const dir = await makeApp({
      'routes/web.ts': `import { Router } from '@guren/core'

export function registerWebRoutes(router: Router): void {
  router.get('/', () => 'home')
}
`,
      'modules/billing/routes.ts': `import { Router } from '@guren/core'

export function registerBillingRoutes(router: Router): void {
  router.get('/invoices', () => 'invoices').name('invoices.index').agent({})
}
`,
    })

    expect(await appDeclaresAgentRoutes(dir)).toBe(true)
  })
})
