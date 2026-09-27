import { describe, expect, test } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

import { applicationGraphSchema, buildApplicationGraph, graphId, graphResultSchema, type ApplicationGraphInputs } from '../src/application-graph'
import { loadApplicationGraph } from '../src/application-graph-load'
import { freshApplicationGraph } from '../src/application-graph-fresh'
import { createDevMcpHandler } from '../src/dev-mcp/handler'
import { createTempWorkspace, linkWorkspaceCore, runCliBinCaptured, writeWorkspaceFiles } from './helpers'
import { connectDevMcpClient, toolText } from './dev-mcp-client'

import { APPLICATION_GRAPH_FIXTURE as source } from './application-graph-fixture'

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

  test('CLI partial JSON survives exit 1; registered graph is fresh through a persistent MCP handler', async () => {
    const workspace = await createTempWorkspace('guren-graph-live-')
    const handler = createDevMcpHandler({ cwd: workspace.dir })
    let client
    try {
      await linkWorkspaceCore(workspace.dir)
      await writeWorkspaceFiles(workspace.dir, source)
      const cli = await runCliBinCaptured(['graph', '--json'], workspace.dir)
      expect(cli.exitCode).toBe(1)
      const graph = graphResultSchema.parse(JSON.parse(cli.stdout))
      if ('error' in graph) throw new Error(graph.error.message)
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
    } finally { await client?.close(); await handler.close(); await workspace.cleanup() }
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
  })
})
