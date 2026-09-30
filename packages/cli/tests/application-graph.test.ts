import { describe, expect, test } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

import { applicationGraphSchema, buildApplicationGraph, GRAPH_KINDS, GRAPH_RELATIONS, graphId, graphResultSchema, isCompleteGraph, type ApplicationGraphInputs, type GurenApplicationGraph } from '../src/application-graph'
import { loadApplicationGraph } from '../src/application-graph-load'
import { freshApplicationGraph } from '../src/application-graph-fresh'
import { createDevMcpHandler } from '../src/dev-mcp/handler'
import { INTROSPECT_GRAPH_ENV, introspectApp, type GraphRouteEntry } from '../src/introspect'
import { createTempWorkspace, linkWorkspaceCore, runCliBinCaptured, writeWorkspaceFiles } from './helpers'
import { connectDevMcpClient, toolText } from './dev-mcp-client'

import { APPLICATION_GRAPH_FIXTURE as source, APPLICATION_GRAPH_RELATIONS_FIXTURE as relations } from './application-graph-fixture'

function related(graph: GurenApplicationGraph, relation: string): string[] {
  const label = (id: string) => graph.nodes.find((node) => node.id === id)?.label
  return graph.edges.filter((edge) => edge.relation === relation).map((edge) => `${label(edge.from)} -> ${label(edge.to)}`).sort()
}

function codes(graph: GurenApplicationGraph, key: string): string[] {
  return graph.coverage[key]!.reasons.map((reason) => reason.code)
}

function input(): ApplicationGraphInputs {
  return { nodes: [{ id: graphId('model', 'app/Models/A.ts', 'A'), kind: 'model', label: 'A', module: null, evidence: [] }],
    edges: [], unresolved: [], coverage: {}, capturedAt: '2026-09-28T00:00:00.000Z' }
}

describe('application graph', () => {
  test('canonical content ignores capture time and object insertion order but fingerprints matter', () => {
    const first = input()
    first.fingerprints = { b: '2', a: '1' }
    const second = { ...first, capturedAt: 'later', fingerprints: { a: '1', b: '2' } }
    expect(buildApplicationGraph(first).snapshot.id).toBe(buildApplicationGraph(second).snapshot.id)
    second.fingerprints.a = 'changed'
    expect(buildApplicationGraph(first).snapshot.id).not.toBe(buildApplicationGraph(second).snapshot.id)
    expect(applicationGraphSchema.safeParse(buildApplicationGraph(first)).success).toBe(true)
  })

  test('rejects duplicate IDs and never emits dangling edges', () => {
    const data = input()
    data.edges.push({ from: data.nodes[0]!.id, to: 'missing', relation: 'binds', evidence: [] })
    const graph = buildApplicationGraph(data)
    expect(graph.edges).toEqual([])
    expect(graph.coverage.binds!.status).toBe('partial')
    expect(graph.unresolved[0]?.target).toBe('missing')
    data.nodes.push(data.nodes[0]!)
    expect(() => buildApplicationGraph(data)).toThrow('Duplicate')
  })

  test('static mode does not execute the entry; preserves modules and dynamic references', async () => {
    const workspace = await createTempWorkspace('guren-graph-static-')
    try {
      await writeWorkspaceFiles(workspace.dir, { ...source,
        'src/main.ts': "throw new Error('must not run')",
        'modules/blog/app/Models/Post.ts': 'export class Post {}',
        'app/Http/Controllers/DynamicController.ts': 'export class DynamicController { show() { return this.inertia(name) } }',
      })
      const graph = await loadApplicationGraph({ cwd: workspace.dir, introspect: false })
      expect(graph.nodes.filter((entry) => entry.kind === 'model').map((entry) => entry.module).sort()).toEqual([null, 'blog'].sort())
      expect(graph.coverage.route!.reasons[0]!.code).toBe('disabled')
      expect(graph.edges.filter((edge) => edge.relation === 'renders')).toHaveLength(1)
      expect(graph.unresolved.some((entry) => entry.reason.includes('dynamic'))).toBe(true)
      expect(graph.coverage.renders!.status).toBe('partial')
    } finally { await workspace.cleanup() }
  })

  test('partial source keeps readable sections and reports malformed models', async () => {
    const workspace = await createTempWorkspace('guren-graph-broken-')
    try {
      await writeWorkspaceFiles(workspace.dir, { ...source, 'app/Models/Broken.ts': 'export class {' })
      const graph = await loadApplicationGraph({ cwd: workspace.dir, introspect: false })
      expect(graph.coverage.model!.status).toBe('partial')
      expect(graph.nodes.some((entry) => entry.label === 'Post')).toBe(true)
      expect(graph.nodes.some((entry) => entry.label === 'posts/Index')).toBe(true)
      await writeFile(join(workspace.dir, 'modules'), 'not a directory')
      const broken = await loadApplicationGraph({ cwd: workspace.dir, introspect: false })
      expect(broken.coverage.controller!.status).toBe('partial')
      expect(broken.coverage.page!.status).toBe('complete')
    } finally { await workspace.cleanup() }
  })

  test('CLI exits 0 on a complete graph and keeps partial JSON on exit 1; registered graph is fresh through a persistent MCP handler', async () => {
    const workspace = await createTempWorkspace('guren-graph-live-')
    const handler = createDevMcpHandler({ cwd: workspace.dir })
    let client
    try {
      await linkWorkspaceCore(workspace.dir)
      await writeWorkspaceFiles(workspace.dir, source)
      const cli = await runCliBinCaptured(['graph', '--json'], workspace.dir)
      expect(cli.exitCode).toBe(0)
      const graph = graphResultSchema.parse(JSON.parse(cli.stdout))
      if ('error' in graph) throw new Error(graph.error.message)
      expect(isCompleteGraph(graph)).toBe(true)
      expect(graph.edges.map((edge) => edge.relation).sort()).toEqual(['binds', 'handles', 'renders'])
      expect(graph.coverage.route!.status).toBe('complete')
      const fresh = await freshApplicationGraph(workspace.dir)
      expect('snapshot' in fresh && fresh.snapshot.id).toBe(graph.snapshot.id)
      client = await connectDevMcpClient((request) => handler.fetch(request), 'modern')
      const first = JSON.parse(toolText(await client.callTool({ name: 'guren_get_application_graph', arguments: {} })))
      expect(first.snapshot.id).toBe(graph.snapshot.id)
      await writeFile(join(workspace.dir, 'app/Models/Post.ts'), 'export class Post { static changed = true }')
      const second = JSON.parse(toolText(await client.callTool({ name: 'guren_get_application_graph', arguments: {} })))
      expect(second.snapshot.id).not.toBe(first.snapshot.id)
      const errors = JSON.parse(toolText(await client.callTool({ name: 'guren_get_runtime_errors', arguments: {} })))
      expect(errors.status).toBe('unavailable')
      await writeFile(join(workspace.dir, 'app/Models/Broken.ts'), 'export class {')
      const partial = await runCliBinCaptured(['graph', '--json'], workspace.dir)
      expect(partial.exitCode).toBe(1)
      const partialGraph = applicationGraphSchema.parse(JSON.parse(partial.stdout))
      expect(partialGraph.coverage.model!.status).toBe('partial')
      expect(partialGraph.nodes.some((node) => node.kind === 'route')).toBe(true)
    } finally { await client?.close(); await handler.close(); await workspace.cleanup() }
  }, 30_000)

  test('fills middleware, validator, policy and test sections from registered routes and existing readers', async () => {
    const workspace = await createTempWorkspace('guren-graph-relations-')
    try {
      await linkWorkspaceCore(workspace.dir)
      await writeWorkspaceFiles(workspace.dir, relations)
      const graph = await loadApplicationGraph({ cwd: workspace.dir })
      expect(applicationGraphSchema.safeParse(graph).success).toBe(true)
      for (const key of [...GRAPH_KINDS, ...GRAPH_RELATIONS]) expect(codes(graph, key)).not.toContain('unsupported')
      expect(graph.nodes.filter((node) => node.kind === 'middleware').map((node) => node.label).sort()).toEqual(['auth', 'log', 'web'])
      expect(related(graph, 'usesMiddleware')).toEqual(['posts.show -> auth', 'posts.show -> log', 'posts.show -> web', 'posts.store -> auth'])
      expect(graph.unresolved).toContainEqual(expect.objectContaining({ relation: 'usesMiddleware', target: 'stamp' }))
      expect(codes(graph, 'usesMiddleware')).toEqual(['inline-middleware'])

      expect(related(graph, 'validates')).toEqual(['PostController -> PostPayloadSchema', 'posts.show -> PostParamsSchema', 'posts.store -> PostPayloadSchema'])
      expect(graph.unresolved.filter((entry) => entry.relation === 'validates').map((entry) => entry.target).sort()).toEqual(['Local', 'POST /posts query'])
      expect(graph.coverage.validator!.status).toBe('complete')

      // Only the store action names the policy class; update reaches it through the gate, paired by name alone.
      const authorizes = graph.edges.filter((edge) => edge.relation === 'authorizes')
      expect(related(graph, 'authorizes')).toEqual(['PostController -> PostPolicy'])
      expect(authorizes[0]!.evidence.map((entry) => entry.source)).toEqual(['controller:store'])
      expect(graph.unresolved).toContainEqual(expect.objectContaining({ relation: 'authorizes', target: 'PostPolicy' }))
      expect(codes(graph, 'authorizes')).toEqual(['boot-bound-policy'])

      const tests = graph.edges.filter((edge) => edge.relation === 'tests')
      expect(related(graph, 'tests')).toEqual(['tests/posts.test.ts -> posts.show'])
      expect(tests[0]!.evidence.map((entry) => entry.line)).toEqual([5, 6])
      expect(graph.unresolved).toContainEqual(expect.objectContaining({ relation: 'tests', target: 'GET /missing' }))
      expect(graph.coverage.tests!.status).toBe('complete')
    } finally { await workspace.cleanup() }
  }, 30_000)

  test('without introspection, route-only sections are unavailable and the static halves stay partial', async () => {
    const workspace = await createTempWorkspace('guren-graph-relations-static-')
    try {
      await writeWorkspaceFiles(workspace.dir, { ...relations, 'src/main.ts': "throw new Error('must not run')" })
      const graph = await loadApplicationGraph({ cwd: workspace.dir, introspect: false })
      for (const key of ['route', 'handles', 'binds', 'middleware', 'usesMiddleware', 'tests']) {
        expect(graph.coverage[key]).toEqual(expect.objectContaining({ status: 'unavailable' }))
        expect(codes(graph, key)).toEqual(['disabled'])
      }
      expect(codes(graph, 'validates')).toContain('routes-disabled')
      expect(codes(graph, 'authorizes')).toContain('routes-disabled')
      expect(related(graph, 'validates')).toEqual(['PostController -> PostPayloadSchema'])
      expect(graph.nodes.filter((node) => ['validator', 'policy', 'test'].includes(node.kind)).map((node) => node.label).sort())
        .toEqual(['PostParamsSchema', 'PostPayloadSchema', 'PostPolicy', 'tests/posts.test.ts'])
    } finally { await workspace.cleanup() }
  })

  test('records what the validate and policy readers cannot follow instead of dropping it', async () => {
    const workspace = await createTempWorkspace('guren-graph-unfollowed-')
    try {
      await writeWorkspaceFiles(workspace.dir, { ...relations,
        'src/main.ts': "throw new Error('must not run')",
        'app/Policies/index.ts': "export { PostPolicy } from './PostPolicy'",
        'app/Policies/CommentPolicy.ts': 'export class CommentPolicy { create() { return true } }',
        'app/Models/Comment.ts': 'export class Comment {}',
        'app/Http/Controllers/CommentController.ts': `import { Controller } from '@guren/core'
import type { CommentPolicy } from '../../Policies/CommentPolicy'
import { PostPolicy } from '../../Policies'
import { Comment } from '../../Models/Comment'
export class CommentController extends Controller {
  async store() { await this.validateBody({ safeParse: (data: unknown) => ({ success: true, data }) }); return null as unknown as CommentPolicy }
  async update() { new PostPolicy(); await this.authorize('create', Comment) }
}`,
      })
      const graph = await loadApplicationGraph({ cwd: workspace.dir, introspect: false })
      const from = (label: string) => graph.nodes.find((node) => node.label === label)!.id
      const unresolved = (relation: string) => graph.unresolved.filter((entry) => entry.relation === relation && entry.from === from('CommentController')).map((entry) => entry.target).sort()
      expect(unresolved('validates')).toEqual(['CommentController.store'])
      expect(codes(graph, 'validates')).toContain('dynamic-schema')
      // A type-only import authorizes nothing; a barrel import is a name match; a gate call still names its candidate.
      expect(related(graph, 'authorizes')).toEqual(['PostController -> PostPolicy'])
      expect(unresolved('authorizes')).toEqual(['CommentPolicy', 'PostPolicy'])
      expect(codes(graph, 'authorizes')).toEqual(expect.arrayContaining(['boot-bound-policy', 'unresolved-policy-import']))
    } finally { await workspace.cleanup() }
  })

  test('only a graph run reports identities, whatever the parent process inherited', async () => {
    const workspace = await createTempWorkspace('guren-graph-env-')
    const inherited = process.env[INTROSPECT_GRAPH_ENV]
    try {
      await linkWorkspaceCore(workspace.dir)
      await writeWorkspaceFiles(workspace.dir, relations)
      process.env[INTROSPECT_GRAPH_ENV] = '1'
      const plain = await introspectApp(workspace.dir, { fresh: true })
      const graph = await introspectApp(workspace.dir, { fresh: true, graph: true })
      if (plain.status !== 'ok' || graph.status !== 'ok') throw new Error('introspection failed')
      const show = (routes: GraphRouteEntry[]) => routes.find((route) => route.name === 'posts.show')!
      expect(show(plain.manifest.routes).bindingSources).toBeUndefined()
      expect(show(plain.manifest.routes).contractSources).toBeUndefined()
      expect(show(graph.manifest.routes).contractSources).toEqual({ params: [{ file: 'app/Http/Validators/PostValidator.ts', exportName: 'PostParamsSchema' }] })
      expect(show(graph.manifest.routes).bindingSources?.post?.file).toBe('app/Models/Post.ts')
    } finally {
      if (inherited === undefined) delete process.env[INTROSPECT_GRAPH_ENV]
      else process.env[INTROSPECT_GRAPH_ENV] = inherited
      await workspace.cleanup()
    }
  }, 30_000)

  test('marks a snapshot changed when registration modifies a source file', async () => {
    const workspace = await createTempWorkspace('guren-graph-race-')
    try {
      await linkWorkspaceCore(workspace.dir)
      await writeWorkspaceFiles(workspace.dir, { ...source,
        'src/main.ts': `import { writeFileSync } from 'node:fs'
${source['src/main.ts']}
writeFileSync('app/Models/Post.ts', 'export class Changed {}')`,
      })
      const graph = await loadApplicationGraph({ cwd: workspace.dir })
      expect(graph.snapshot.consistency).toBe('changed')
      expect(graph.coverage.freshness!.status).toBe('partial')
    } finally { await workspace.cleanup() }
  })

  test('keeps duplicate registrations and resolves actual binding identity across same-named classes', async () => {
    const workspace = await createTempWorkspace('guren-graph-duplicates-')
    try {
      await linkWorkspaceCore(workspace.dir)
      await writeWorkspaceFiles(workspace.dir, { ...source,
        'app/Models/Other.ts': 'export class Post {}',
        'src/main.ts': source['src/main.ts'].replace("router.get('/posts/:post',", "router.get('/posts/:post', [PostController, 'index']).name('posts.show')\n  router.get('/posts/:post',"),
      })
      const graph = await loadApplicationGraph({ cwd: workspace.dir })
      const routes = graph.nodes.filter((node) => node.kind === 'route')
      expect(routes).toHaveLength(2)
      expect(new Set(routes.map((node) => node.id)).size).toBe(2)
      expect(routes.map((node) => node.route!.order).sort()).toEqual([0, 1])
      const bound = graph.edges.filter((edge) => edge.relation === 'binds')
      expect(bound).toHaveLength(2)
      expect(bound.every((edge) => graph.nodes.find((node) => node.id === edge.to)?.file === 'app/Models/Post.ts')).toBe(true)
      expect(graph.coverage.binds!.status).toBe('complete')
    } finally { await workspace.cleanup() }
  })

  test('missing entry is distinct from an empty registered route set', async () => {
    const workspace = await createTempWorkspace('guren-graph-no-entry-')
    try {
      const graph = await loadApplicationGraph({ cwd: workspace.dir })
      expect(graph.coverage.route!.reasons[0]!.code).toBe('no-entry')
      expect(graph.coverage.model!.status).toBe('complete')
      expect(graph.nodes).toEqual([])
    } finally { await workspace.cleanup() }
  })

  test('published JSON schema matches the runtime contract', async () => {
    const schema = await Bun.file(join(import.meta.dir, '../assets/application-graph.schema.json')).json()
    expect(schema).toEqual(z.toJSONSchema(graphResultSchema))
    const graph = schema.anyOf[0].properties
    expect(graph.nodes.items.properties.kind.enum).toEqual([...GRAPH_KINDS])
    expect(graph.edges.items.properties.relation.enum).toEqual([...GRAPH_RELATIONS])
  })
})
