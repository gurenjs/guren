import { describe, expect, test } from 'bun:test'
import { chmod, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { loadApplicationGraph } from '../src/application-graph-load'
import type { GurenApplicationGraph } from '../src/application-graph'
import { loadPlanAppState } from '../src/plan/app-state'
import type { PlanImpactSources } from '../src/plan/impact'
import { APPLICATION_GRAPH_FIXTURE } from './application-graph-fixture'
import { createTempWorkspace, linkWorkspaceCore, writeWorkspaceFiles } from './helpers'

const REQUESTS = `import { TestApp } from '@guren/testing'
const http = await TestApp.create()
await http.get('/posts/create')
await http.get('/posts/1')
await http.get('/missing')
throw new Error('request files must never execute')
`

function fixture(routes: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...APPLICATION_GRAPH_FIXTURE,
    'routes/web.ts': `export function registerWebRoutes(router) { ${routes} }`,
    'src/main.ts': `import { createApp } from '@guren/core'
import { registerWebRoutes } from '../routes/web'
export default createApp({ routes: registerWebRoutes })`,
    'tests/posts.test.ts': REQUESTS,
    ...extra,
  }
}

function graphSites(graph: GurenApplicationGraph): string[] {
  return graph.edges.filter((edge) => edge.relation === 'tests').flatMap((edge) => {
    const route = graph.nodes.find((node) => node.id === edge.to)!
    return edge.evidence.map((site) => `${route.label}:${site.file}:${site.line}`)
  }).sort()
}

function impactSites(impact: PlanImpactSources): string[] {
  return impact.routes.flatMap((route) => (route.tests ?? []).map((site) => `${route.name}:${site.file}:${site.line}`)).sort()
}

describe('M3 reader boundaries', () => {
  test.each([
    {
      label: 'literal route precedes a parameter',
      routes: "router.get('/posts/create', () => null).name('posts.create'); router.get('/posts/:id', () => null).name('posts.show')",
      sites: ['posts.create:tests/posts.test.ts:3', 'posts.show:tests/posts.test.ts:4'],
    },
    {
      label: 'parameter route shadows a literal',
      routes: "router.get('/posts/:id', () => null).name('posts.show'); router.get('/posts/create', () => null).name('posts.create')",
      sites: ['posts.show:tests/posts.test.ts:3', 'posts.show:tests/posts.test.ts:4'],
    },
    {
      label: 'ALL route shadows later GET routes',
      routes: "router.on('ALL', '/posts/*', () => null).name('posts.all'); router.get('/posts/:id', () => null).name('posts.show')",
      sites: ['posts.all:tests/posts.test.ts:3', 'posts.all:tests/posts.test.ts:4'],
    },
  ])('Graph and Impact agree when $label', async ({ routes, sites }) => {
    const workspace = await createTempWorkspace('guren-reader-parity-')
    try {
      await linkWorkspaceCore(workspace.dir)
      await writeWorkspaceFiles(workspace.dir, fixture(routes))
      const graph = await loadApplicationGraph({ cwd: workspace.dir })
      const impact = (await loadPlanAppState(workspace.dir, { impact: true })).impact!
      expect(graphSites(graph)).toEqual([...sites])
      expect(impactSites(impact)).toEqual([...sites])
      expect(graph.coverage.tests!.status).toBe('complete')
      expect(graph.unresolved).toContainEqual(expect.objectContaining({ relation: 'tests', target: 'GET /missing' }))
      expect(impact.testRequests).toEqual({ unresolved: [], unparsed: [] })
      expect(impact.unreadable.tests).toBeUndefined()
    } finally { await workspace.cleanup() }
  })

  test('cross-module reachability stays conservative in both registered and source views', async () => {
    const workspace = await createTempWorkspace('guren-reader-module-order-')
    try {
      await linkWorkspaceCore(workspace.dir)
      const moduleFiles = Object.fromEntries(['alpha', 'beta'].map((name) => [
        `modules/${name}/index.ts`,
        `import { defineModule } from '@guren/core'
export default defineModule({ name: '${name}', providers: [], routes(router) {
  router.get('/posts/:id', () => null).name('${name}.show')
} })`,
      ]))
      await writeWorkspaceFiles(workspace.dir, fixture('', {
        ...moduleFiles,
        'src/main.ts': `import { createApp } from '@guren/core'
import alpha from '../modules/alpha'
import beta from '../modules/beta'
export default createApp({ modules: [beta, alpha] })`,
      }))
      const graph = await loadApplicationGraph({ cwd: workspace.dir })
      const impact = (await loadPlanAppState(workspace.dir, { impact: true })).impact!
      expect(graphSites(graph)).toEqual([])
      expect(graph.coverage.tests!.status).toBe('partial')
      expect(graph.coverage.tests!.reasons).toContainEqual(expect.objectContaining({ code: 'routeOrder' }))
      expect(graph.unresolved.filter((entry) => entry.relation === 'tests' && entry.reason.includes('unknown module order'))).toHaveLength(4)
      expect(impactSites(impact)).toEqual([])
      expect(impact.routes.map((route) => route.name).sort()).toEqual(['alpha.show', 'beta.show'])
      for (const route of impact.routes) {
        expect(route.uncertainTests).toEqual([
          expect.objectContaining({ file: 'tests/posts.test.ts', line: 3, reason: 'routeOrder' }),
          expect.objectContaining({ file: 'tests/posts.test.ts', line: 4, reason: 'routeOrder' }),
        ])
      }
    } finally { await workspace.cleanup() }
  })

  test('malformed requests keep valid evidence and each view reports the unread source', async () => {
    const workspace = await createTempWorkspace('guren-reader-unparsed-')
    try {
      await linkWorkspaceCore(workspace.dir)
      await writeWorkspaceFiles(workspace.dir, fixture("router.get('/posts/:id', () => null).name('posts.show')", {
        'tests/broken.test.ts': "import { TestApp } from '@guren/testing'\nconst http = await TestApp.create(",
      }))
      const graph = await loadApplicationGraph({ cwd: workspace.dir })
      const impact = (await loadPlanAppState(workspace.dir, { impact: true })).impact!
      expect(graphSites(graph)).toEqual(impactSites(impact))
      expect(graphSites(graph)).toHaveLength(2)
      expect(graph.coverage.tests!.status).toBe('partial')
      expect(graph.coverage.tests!.reasons).toContainEqual(expect.objectContaining({ code: 'unparsed', file: 'tests/broken.test.ts' }))
      expect(impact.testRequests.unparsed).toEqual(['tests/broken.test.ts'])
      expect(impact.tests).toEqual(['tests/broken.test.ts', 'tests/posts.test.ts'])
    } finally { await workspace.cleanup() }
  })

  test('a dynamic request stays unresolved in both views', async () => {
    const workspace = await createTempWorkspace('guren-reader-dynamic-')
    try {
      await linkWorkspaceCore(workspace.dir)
      await writeWorkspaceFiles(workspace.dir, fixture("router.get('/posts/:id', () => null).name('posts.show')", {
        'tests/posts.test.ts': `import { TestApp } from '@guren/testing'
const http = await TestApp.create()
await http.get(path)
throw new Error('request files must never execute')`,
      }))
      const graph = await loadApplicationGraph({ cwd: workspace.dir })
      const impact = (await loadPlanAppState(workspace.dir, { impact: true })).impact!
      expect(graphSites(graph)).toEqual([])
      expect(impactSites(impact)).toEqual([])
      expect(graph.coverage.tests!.status).toBe('partial')
      expect(graph.coverage.tests!.reasons).toContainEqual(expect.objectContaining({ code: 'dynamicPath', file: 'tests/posts.test.ts' }))
      expect(impact.testRequests.unresolved).toEqual([expect.objectContaining({ reason: 'dynamicPath', file: 'tests/posts.test.ts', line: 3 })])
    } finally { await workspace.cleanup() }
  })

  test('an absent test directory is complete empty evidence', async () => {
    const workspace = await createTempWorkspace('guren-reader-empty-')
    try {
      await linkWorkspaceCore(workspace.dir)
      await writeWorkspaceFiles(workspace.dir, fixture("router.get('/posts/:id', () => null).name('posts.show')"))
      await rm(join(workspace.dir, 'tests'), { recursive: true })
      const graph = await loadApplicationGraph({ cwd: workspace.dir })
      const impact = (await loadPlanAppState(workspace.dir, { impact: true })).impact!
      expect(graph.coverage.test!.status).toBe('complete')
      expect(graph.coverage.tests!.status).toBe('complete')
      expect(graphSites(graph)).toEqual([])
      expect(impact.tests).toEqual([])
      expect(impact.testRequests).toEqual({ unresolved: [], unparsed: [] })
      expect(impact.unreadable.tests).toBeUndefined()
    } finally { await workspace.cleanup() }
  })

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('an unavailable test directory cannot imply complete empty evidence', async () => {
    const workspace = await createTempWorkspace('guren-reader-unavailable-')
    try {
      await linkWorkspaceCore(workspace.dir)
      await writeWorkspaceFiles(workspace.dir, fixture("router.get('/posts/:id', () => null).name('posts.show')"))
      await chmod(join(workspace.dir, 'tests'), 0o000)
      const graph = await loadApplicationGraph({ cwd: workspace.dir })
      const impact = (await loadPlanAppState(workspace.dir, { impact: true })).impact!
      expect(graph.coverage.test!.status).toBe('partial')
      expect(graph.coverage.tests!.status).toBe('partial')
      expect(graph.coverage.test!.reasons).toContainEqual(expect.objectContaining({ code: 'unreadable-directory', file: 'tests' }))
      expect(impact.unreadable.tests).toContain('tests would not open')
      expect(graphSites(graph)).toEqual([])
      expect(impactSites(impact)).toEqual([])
    } finally {
      await chmod(join(workspace.dir, 'tests'), 0o755)
      await workspace.cleanup()
    }
  })

  test('middleware evidence stays registered and unavailable without introspection', async () => {
    const workspace = await createTempWorkspace('guren-reader-middleware-')
    try {
      await linkWorkspaceCore(workspace.dir)
      await writeWorkspaceFiles(workspace.dir, fixture(`
const pass = async (_c, next) => next()
router.aliasMiddleware('auth', pass).groupMiddleware('web', ['auth', 'missing'])
router.get('/posts/:id', () => null).name('posts.show').middleware('web', pass)`))
      const graph = await loadApplicationGraph({ cwd: workspace.dir })
      const impact = (await loadPlanAppState(workspace.dir, { impact: true })).impact!
      expect(graphSites(graph)).toEqual(impactSites(impact))
      expect(graph.nodes.filter((node) => node.kind === 'middleware').map((node) => node.label).sort()).toEqual(['auth', 'web'])
      expect(graph.coverage.usesMiddleware!.status).toBe('partial')
      expect(graph.coverage.usesMiddleware!.reasons.map((reason) => reason.code).sort()).toEqual(['inline-middleware', 'unregistered-middleware'])
      expect(graph.unresolved).toContainEqual(expect.objectContaining({ relation: 'usesMiddleware', target: 'missing' }))
      const staticGraph = await loadApplicationGraph({ cwd: workspace.dir, introspect: false })
      for (const key of ['middleware', 'usesMiddleware', 'tests']) expect(staticGraph.coverage[key]!.status).toBe('unavailable')
      expect(staticGraph.nodes.some((node) => node.kind === 'test')).toBe(true)
    } finally { await workspace.cleanup() }
  })
})
