import { describe, expect, test, afterEach } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { Controller, Router, deriveAgentTools, type RouteDefinition } from '@guren/core'
import { authorizeMiddleware } from '@guren/core'
import { checkTypes, GENERATED_MODULE_COMPILER_OPTIONS, TSC_TIMEOUT, writeWorkspaceFiles } from './helpers'
import {
  AGENTS_MANIFEST_FILE,
  appDeclaresAgentRoutes,
  buildAgentToolsContent,
  generateAgentTypes,
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
class ArticleResource {}

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
