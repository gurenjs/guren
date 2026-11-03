import { expect, test } from 'bun:test'
import { symlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { buildApplicationGraph, graphId, type GraphNode } from '../src/application-graph'
import { loadApplicationGraph } from '../src/application-graph-load'
import { readRouteGraph, readRoutesFileGraph, type RouteGraphSource, type RoutesFileGraphReading } from '../src/application-graph-routes'
import { routeDefinitionToContextRoute } from '../src/context-route'
import { parseControllerMethods } from '../src/controller-methods'
import { loadRouteDefinitions, resolveRoutesFile } from '../src/load-routes'
import { ParseCache } from '../src/parse-cache'
import { loadPlanAppDetail, readValidatorExports } from '../src/plan/app-detail'
import { appNames, isUnreadable, loadPlanAppState } from '../src/plan/app-state'
import { judgeFreshness, stampContextHash } from '../src/plan/freshness'
import { PlanDraftSchema } from '../src/plan/schema'
import { judgePlan } from '../src/plan/status'
import { validatePlan } from '../src/plan/validate'
import { createTempWorkspace, linkWorkspaceCore, writeWorkspaceFiles } from './helpers'
import { loadCommentsPlan } from './plan-fixture'

/** RFC 0030's registrar-based reading, retained independently for approval and detailed-status parity. */
async function legacyReading(cwd: string, routesFile?: string): Promise<Omit<RoutesFileGraphReading, 'entries'>> {
  const target = await resolveRoutesFile(cwd, routesFile)
  const section: Omit<RoutesFileGraphReading, 'entries'> = { routes: [], definitions: undefined, file: undefined, provenance: [], moduleWarnings: [] }
  if (target.silentlyAbsent) return section
  try {
    const definitions = await loadRouteDefinitions(resolve(cwd, target.path), cwd, section.moduleWarnings, section.provenance)
    return { ...section, file: target.path, definitions, routes: definitions.map(routeDefinitionToContextRoute) }
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)) || 'the routes file threw without a message'
    return { ...section, file: target.path, routes: { unreadable: reason } }
  }
}

const sources = {
  'package.json': '{"type":"module"}',
  'app/Http/Validators/Comment.ts': `import { z } from 'zod'
export const CommentParamsSchema = z.object({ postId: z.coerce.number() })
export const CommentBodySchema = z.object({ body: z.string() })
export const CommentQuerySchema = z.object({ page: z.coerce.number().optional() })
export const CommentOutputSchema = z.object({ id: z.number() })`,
  'app/Http/Controllers/CommentController.ts': `import { Controller } from '@guren/core'
import { CommentBodySchema } from '../Validators/Comment'
export class CommentController extends Controller {
  async store() { await this.validateBody(CommentBodySchema); return this.json({ id: 1 }) }
  destroy() { return this.json({ ok: true }) }
}`,
  'routes/web.ts': `import { CommentController } from '../app/Http/Controllers/CommentController'
import { CommentParamsSchema, CommentBodySchema, CommentQuerySchema, CommentOutputSchema } from '../app/Http/Validators/Comment'
export function registerWebRoutes(router) {
  router.post('/posts/:postId/comments', { params: CommentParamsSchema, body: CommentBodySchema, query: CommentQuerySchema, output: CommentOutputSchema }, [CommentController, 'store']).name('comments.store')
  router.delete('/comments/:commentId', [CommentController, 'destroy']).name('comments.destroy')
  router.get('/echo', (c) => c.text('first')).name('echo')
  router.get('/echo', (c) => c.text('second')).name('echo')
  router.get('/unnamed', (c) => c.text('ok'))
  router.get('/empty', (c) => c.text('ok')).name('')
}`,
  'modules/billing/index.ts': `import { defineModule } from '@guren/core'
export default defineModule({ name: 'billing-public', providers: [], routes(router) {
  router.get('/billing/echo', (c) => c.text('ok')).name('echo')
} })`,
  'src/main.ts': "throw new Error('Plan must not execute the application entry')",
}

const scenarios: Record<string, { files: Record<string, string>; routesFile?: string; unreadable?: boolean }> = {
  'missing default registrar': { files: {} },
  'missing default with a discovered module': { files: { 'modules/billing/index.ts': sources['modules/billing/index.ts'] } },
  'registration order, duplicate names, module directory/name mismatch and live contracts': { files: sources },
  'explicit registrar override': { files: { ...sources, 'routes/custom.ts': "export default (router) => router.get('/custom', (c) => c.text('ok')).name('custom')" }, routesFile: 'routes/custom.ts' },
  'missing explicitly named registrar': { files: {}, routesFile: 'routes/missing.ts', unreadable: true },
  'message-less registrar exception': { files: { 'routes/web.ts': 'throw new Error()' }, unreadable: true },
  'a module without an entry': { files: { ...sources, 'modules/orphan/README.md': 'mid-scaffold' } },
  'a module registrar that throws': { files: { ...sources, 'modules/billing/index.ts': "import { defineModule } from '@guren/core'; export default defineModule({ name: 'billing', providers: [], routes() { throw new Error('module failed') } })" }, unreadable: true },
  'unreadable modules directory': { files: { 'routes/web.ts': "export default (router) => router.get('/', (c) => c.text('ok'))", modules: 'not a directory' }, unreadable: true },
}

for (const [description, scenario] of Object.entries(scenarios)) {
  test(`Route convergence preserves Plan verdicts, approval facts and detailed contracts: ${description}`, async () => {
    const workspace = await createTempWorkspace('guren-plan-route-')
    try {
      await linkWorkspaceCore(workspace.dir)
      await symlink(resolve(import.meta.dir, '../../../node_modules/zod'), resolve(workspace.dir, 'node_modules/zod'), 'dir')
      await writeWorkspaceFiles(workspace.dir, scenario.files)
      const legacy = await legacyReading(workspace.dir, scenario.routesFile)
      expect(Array.isArray(legacy.routes)).toBe(!scenario.unreadable)
      const reading = await readRoutesFileGraph(workspace.dir, scenario.routesFile)
      const { entries, ...currentReading } = reading
      expect(currentReading).toEqual(legacy)
      for (const [index, entry] of entries.entries()) expect(entry.route).toBe(reading.definitions![index])
      const current = await loadPlanAppState(workspace.dir, { detail: true, impact: true, routesFile: scenario.routesFile })
      const detail = await loadPlanAppDetail({ root: workspace.dir, routesFile: legacy.file, routes: legacy.routes,
        definitions: legacy.definitions, provenance: legacy.provenance, moduleWarnings: legacy.moduleWarnings,
        controllers: await parseControllerMethods(workspace.dir).catch((error: unknown) => ({ unreadable: error instanceof Error ? error.message : String(error) })), pages: isUnreadable(current.pages) ? current.pages : appNames(current.pages),
        models: isUnreadable(current.models) ? current.models : undefined, validators: await readValidatorExports(workspace.dir, new ParseCache()),
      })
      const legacyRoutes = Array.isArray(legacy.routes) ? legacy.routes.map(({ name, method, path }) => ({ name, method, path })) : legacy.routes
      // Each route also carries its registered middleware, which the legacy reading left out.
      expect(isUnreadable(current.routes) ? current.routes : current.routes.map(({ name, method, path }) => ({ name, method, path }))).toEqual(legacyRoutes)
      if (!isUnreadable(current.routes)) expect(current.routes.map((route) => route.middleware)).toEqual(legacy.definitions!.map((definition) => definition.middlewareNames ?? []))
      expect(current.detail).toEqual(detail)
      const previous = { ...current, routes: legacyRoutes, detail }
      const plan = PlanDraftSchema.parse(loadCommentsPlan())
      const stamp = stampContextHash(plan, previous)
      expect(stampContextHash(plan, current)).toEqual(stamp)
      expect(validatePlan(plan, current)).toEqual(validatePlan(plan, previous))
      expect(judgePlan(plan, current)).toEqual(judgePlan(plan, previous))
      const approved = { ...plan, baseline: { rev: 'previous-release', contextHash: stamp.contextHash } }
      expect(judgeFreshness(approved, current)).toEqual(judgeFreshness(approved, previous))
    } finally { await workspace.cleanup() }
  })
}

test('graph route projection preserves IDs, order, duplicate occurrences and source references', () => {
  const routes: RouteGraphSource[] = [
    { module: null, method: 'GET', path: '/same', name: 'same', controller: { action: 'first' } },
    { module: null, method: 'GET', path: '/same', name: 'same', controller: { action: 'second' } },
    { module: 'billing', method: 'GET', path: '/same', name: 'same' },
    { module: null, method: 'GET', path: '/unnamed' },
    { module: null, method: 'GET', path: '/empty', name: '' },
  ]
  const occurrences = new Map<string, number>()
  const legacy = routes.map((route, order): GraphNode => {
    const identity = graphId(route.module ?? null, route.method, route.path, route.name ?? null)
    const occurrence = occurrences.get(identity) ?? 0
    occurrences.set(identity, occurrence + 1)
    return { id: graphId('route', route.module ?? null, route.method, route.path, route.name ?? null, occurrence), kind: 'route',
      label: route.name ?? `${route.method} ${route.path}`, module: route.module ?? null,
      route: { method: route.method, path: route.path, ...(route.name ? { name: route.name } : {}), ...(route.controller ? { action: route.controller.action } : {}), order },
      evidence: [{ kind: 'registered', source: 'introspection' }],
    }
  })
  const current = readRouteGraph(routes, 'introspection')
  const currentNodes: GraphNode[] = current.map(({ node }) => node)
  expect(currentNodes).toEqual(legacy)
  current.forEach((entry, index) => expect(entry.route).toBe(routes[index]))
  const graph = (nodes: GraphNode[]) => buildApplicationGraph({ nodes, edges: [], unresolved: [], coverage: {}, capturedAt: 'now' })
  expect(graph(currentNodes).snapshot.id).toBe(graph(legacy).snapshot.id)
  expect(current[0]!.node.id).not.toBe(current[1]!.node.id)
  expect(readRouteGraph([{ method: 'GET', path: '/' }], 'routes-file')[0]!.node.module).toBeNull()
})

test('registrar graph retains live schema identities, directory provenance and the registrar import cache', async () => {
  const workspace = await createTempWorkspace('guren-route-source-')
  try {
    await linkWorkspaceCore(workspace.dir)
    await symlink(resolve(import.meta.dir, '../../../node_modules/zod'), resolve(workspace.dir, 'node_modules/zod'), 'dir')
    await writeWorkspaceFiles(workspace.dir, sources)
    const reading = await readRoutesFileGraph(workspace.dir)
    const body = reading.definitions![0]!.schemas!.body
    expect(reading.entries[0]!.route.schemas!.body).toBe(body)
    expect(reading.entries[0]!.node.evidence).toEqual([{ kind: 'registered', source: 'routes-file' }])
    const module = reading.entries.at(-1)!
    expect(module.node.module).toBe('billing-public')
    expect(reading.provenance.at(-1)).toBe('billing')
    expect(JSON.stringify(reading.entries.map(({ node }) => node))).not.toContain('safeParse')
    await writeFile(resolve(workspace.dir, 'routes/web.ts'), "export default (router) => router.get('/changed', (c) => c.text('ok'))")
    expect((await readRoutesFileGraph(workspace.dir)).routes).toEqual(reading.routes)
    expect((await readRoutesFileGraph(workspace.dir)).definitions![0]!.schemas!.body).toBe(body)
  } finally { await workspace.cleanup() }
})

test('the Plan reading carries each registered route\'s middleware, by name and by declared authentication', async () => {
  const workspace = await createTempWorkspace('guren-route-middleware-')
  try {
    await linkWorkspaceCore(workspace.dir)
    await writeWorkspaceFiles(workspace.dir, {
      'package.json': '{"type":"module"}',
      'routes/web.ts': `import { requireAuthenticated, type Router } from '@guren/core'

export function registerWebRoutes(base: Router): void {
  const router = base.aliasMiddleware('auth', requireAuthenticated({ redirectTo: '/login' }))
  router.get('/open', (c) => c.text('ok')).name('open')
  router.middleware('auth').group((auth) => {
    auth.get('/guarded', (c) => c.text('ok')).name('guarded')
  })
}
`,
    })
    const plan = await loadPlanAppState(workspace.dir)
    expect(plan.routes).toEqual([
      { method: 'GET', path: '/open', name: 'open', middleware: [], hasInlineMiddleware: false, authenticationRequired: false },
      { method: 'GET', path: '/guarded', name: 'guarded', middleware: ['auth'], hasInlineMiddleware: false, authenticationRequired: true },
    ])
  } finally { await workspace.cleanup() }
})

test('registered graph keeps fresh app-only routes while the Plan compatibility reading keeps its registrar', async () => {
  const workspace = await createTempWorkspace('guren-route-authority-')
  try {
    await linkWorkspaceCore(workspace.dir)
    await writeWorkspaceFiles(workspace.dir, {
      'package.json': '{"type":"module"}',
      'routes/web.ts': "export default (router) => router.get('/file', (c) => c.text('ok')).name('file')",
      'src/main.ts': "import { createApp } from '@guren/core'; export default createApp({ routes(router) { router.get('/app', (c) => c.text('ok')).name('app') } })",
    })
    const plan = await loadPlanAppState(workspace.dir)
    expect(plan.routes).toEqual([{ method: 'GET', path: '/file', name: 'file', middleware: [], hasInlineMiddleware: false, authenticationRequired: false }])
    const graph = await loadApplicationGraph({ cwd: workspace.dir })
    expect(graph.nodes.filter((node) => node.kind === 'route').map((node) => node.label)).toEqual(['app'])
    await writeFile(resolve(workspace.dir, 'src/main.ts'), "import { createApp } from '@guren/core'; export default createApp({ routes(router) { router.get('/fresh', (c) => c.text('ok')).name('fresh') } })")
    expect((await loadApplicationGraph({ cwd: workspace.dir })).nodes.filter((node) => node.kind === 'route').map((node) => node.label)).toEqual(['fresh'])
  } finally { await workspace.cleanup() }
}, 30_000)
