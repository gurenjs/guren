import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import { buildApplicationGraph, graphId, type ApplicationGraphInputs, type GraphNode, type GurenApplicationGraph } from '../src/application-graph'
import { BROWSER_MAP_SECTIONS, buildBrowserMap, renderFeatureDoc, renderIndexDoc, type BrowserMap } from '../src/browser-map'
import { approvedPlans } from '../src/browser-map-files'
import { createTempWorkspace, writeWorkspaceFiles } from './helpers'
import { approvePlanFile, loadApprovedCommentsPlan, loadCommentsPlan, loadParsedCommentsPlan } from './plan-fixture'

const POST_CONTROLLER = graphId('controller', 'app/Http/Controllers/PostController.ts', 'PostController')
const POST_MODEL = graphId('model', 'app/Models/Post.ts', 'Post')
const AUTH = graphId('middleware', 'auth')

function page(label: string): GraphNode {
  return { id: graphId('page', `resources/js/pages/${label}.tsx`, label), kind: 'page', label, module: null, evidence: [] }
}

function route(order: number, method: string, path: string, name: string, action?: string): GraphNode {
  return {
    id: graphId('route', null, method, path, name, 0), kind: 'route', label: name, module: null, evidence: [],
    route: { method, path, name, ...(action ? { action } : {}), order },
  }
}

interface Fixture {
  routes: Array<{ node: GraphNode; handled?: boolean; middleware?: boolean; binds?: boolean }>
  renders: Array<{ page: string; actions: string[] }>
  pages: string[]
}

function graphOf(fixture: Fixture, adjust?: (input: ApplicationGraphInputs) => void): GurenApplicationGraph {
  const input: ApplicationGraphInputs = {
    nodes: [
      { id: POST_CONTROLLER, kind: 'controller', label: 'PostController', module: null, evidence: [] },
      { id: POST_MODEL, kind: 'model', label: 'Post', module: null, evidence: [] },
      { id: AUTH, kind: 'middleware', label: 'auth', module: null, evidence: [] },
      ...fixture.pages.map(page),
      ...fixture.routes.map((entry) => entry.node),
    ],
    edges: [],
    unresolved: [],
    coverage: Object.fromEntries([...BROWSER_MAP_SECTIONS, 'usesMiddleware', 'binds'].map((key) => [key, { status: 'complete', reasons: [] }])),
    capturedAt: '2026-10-15T00:00:00.000Z',
  }
  for (const { node, handled = true, middleware, binds } of fixture.routes) {
    if (handled) input.edges.push({ from: node.id, to: POST_CONTROLLER, relation: 'handles', evidence: [{ kind: 'registered', source: 'introspection' }] })
    if (middleware) input.edges.push({ from: node.id, to: AUTH, relation: 'usesMiddleware', evidence: [{ kind: 'registered', source: 'middleware' }] })
    if (binds) input.edges.push({ from: node.id, to: POST_MODEL, relation: 'binds', evidence: [{ kind: 'registered', source: 'binding:id' }] })
  }
  for (const render of fixture.renders) {
    input.edges.push({
      from: POST_CONTROLLER, to: page(render.page).id, relation: 'renders',
      evidence: render.actions.map((action) => ({ kind: 'static' as const, source: `controller:${action}` })),
    })
  }
  adjust?.(input)
  return buildApplicationGraph(input)
}

const BLOG: Fixture = {
  pages: ['posts/Index', 'posts/Show', 'admin/Posts', 'Error'],
  renders: [
    { page: 'posts/Index', actions: ['index'] },
    { page: 'posts/Show', actions: ['show'] },
    { page: 'admin/Posts', actions: ['adminIndex'] },
  ],
  routes: [
    { node: route(0, 'GET', '/posts/:id', 'posts.show', 'show'), binds: true },
    { node: route(1, 'GET', '/posts', 'posts.index', 'index') },
    { node: route(2, 'GET', '/admin/posts', 'admin.posts', 'adminIndex'), middleware: true },
    { node: route(3, 'POST', '/posts', 'posts.store', 'store'), middleware: true },
    { node: route(4, 'GET', '/health', 'health'), handled: false },
  ],
}

function feature(map: BrowserMap, name: string) {
  const found = map.features.find((entry) => entry.name === name)
  if (!found) throw new Error(`no feature ${name}`)
  return found
}

describe('buildBrowserMap', () => {
  test('joins a route to the page its own action renders, never to its controller\'s other pages', () => {
    const map = buildBrowserMap(graphOf(BLOG), [])
    expect(map.complete).toBe(true)
    expect(map.features.map((entry) => entry.name)).toEqual(['admin', 'posts'])
    expect(feature(map, 'posts').routes.map((entry) => entry.name)).toEqual(['posts.show', 'posts.index'])
    expect(feature(map, 'admin').routes.map((entry) => entry.name)).toEqual(['admin.posts'])
    expect(feature(map, 'admin').routes[0]!.middleware).toEqual(['auth'])
  })

  test('lists a render-nothing route as unassigned when its controller renders pages in several features', () => {
    const map = buildBrowserMap(graphOf(BLOG), [])
    expect(map.unassigned).toEqual([
      { method: 'POST', path: '/posts', name: 'posts.store', reason: 'Its action renders nothing, and its controller renders pages in several features.', candidates: ['admin', 'posts'] },
      { method: 'GET', path: '/health', name: 'health', reason: 'Not handled by a controller action.', candidates: [] },
    ])
  })

  test('assigns a render-nothing route when every page its controller renders is in one feature', () => {
    const fixture: Fixture = { ...BLOG, renders: BLOG.renders.slice(0, 2), routes: BLOG.routes.filter((entry) => entry.node.label !== 'admin.posts') }
    const map = buildBrowserMap(graphOf(fixture), [])
    expect(feature(map, 'posts').routes.map((entry) => entry.name)).toContain('posts.store')
  })

  test('picks the first parameterless GET as the landmark and reads entities from bindings', () => {
    const map = buildBrowserMap(graphOf(BLOG), [])
    expect(feature(map, 'posts').landmark?.name).toBe('posts.index')
    expect(feature(map, 'posts').entities).toEqual(['Post'])
    expect(feature(map, 'admin').entities).toEqual([])
  })

  test('reports a page no route renders and a render the graph could not resolve', () => {
    const map = buildBrowserMap(graphOf(BLOG, (input) => {
      input.unresolved.push({ from: POST_CONTROLLER, relation: 'renders', target: 'posts/Detail', reason: 'Page missing or ambiguous.' })
    }), [])
    expect(map.unreached).toEqual(['Error'])
    expect(map.unresolvedRenders).toEqual([{ controller: 'PostController', target: 'posts/Detail', reason: 'Page missing or ambiguous.' }])
  })

  test('is incomplete when a section it rests on is partial or the snapshot changed', () => {
    const partial = buildBrowserMap(graphOf(BLOG, (input) => {
      input.coverage.handles = { status: 'partial', reasons: [{ code: 'controller-identity', message: 'Could not fully read handles.' }] }
    }), [])
    expect(partial.complete).toBe(false)
    expect(partial.gaps).toEqual([{ section: 'handles', reasons: ['Could not fully read handles.'] }])
    const changed = buildBrowserMap(graphOf(BLOG, (input) => { input.changed = true }), [])
    expect(changed.gaps.map((gap) => gap.section)).toEqual(['snapshot'])
  })

  test('treats a section the graph reports no coverage for as a gap, never as complete', () => {
    const graph = graphOf(BLOG)
    delete graph.coverage.renders
    const map = buildBrowserMap(graph, [])
    expect(map.complete).toBe(false)
    expect(map.gaps).toEqual([{ section: 'renders', reasons: ['The graph reported no coverage for this section.'] }])
  })

  test('places plan acceptance by the app route its plan route names, and lists the rest as unplaced', () => {
    const fixture: Fixture = {
      ...BLOG,
      routes: [...BLOG.routes, { node: route(5, 'POST', '/posts/:postId/comments', 'comments.store', 'show') }],
    }
    const map = buildBrowserMap(graphOf(fixture), [{ file: 'comments.plan.json', plan: loadParsedCommentsPlan() }])
    const posts = feature(map, 'posts')
    expect(posts.acceptance.map((entry) => entry.acceptance.id)).toEqual(['AC-comments-1', 'AC-comments-2', 'AC-comments-3'])
    expect(posts.views.map((entry) => entry.view.id)).toEqual(['view.posts.show'])
    expect(map.unplaced).toEqual([{ plan: 'comments.plan.json', id: 'AC-comments-4', route: 'DELETE /comments/:id (comments.destroy)' }])
  })
})

describe('feature documents', () => {
  const map = buildBrowserMap(graphOf(BLOG), [])
  const posts = feature(map, 'posts')

  test('a rerun over its own output is byte-identical', () => {
    const first = renderFeatureDoc(undefined, posts, map)
    if (!('content' in first)) throw new Error('refused')
    expect(renderFeatureDoc(first.content, posts, map)).toEqual(first)
    expect(first.content).toContain('entities: [Post]')
    expect(first.content).toContain('<!-- guren:browser routes -->')
  })

  test('replaces a stale block and keeps the author\'s text and frontmatter', () => {
    const first = renderFeatureDoc(undefined, posts, map)
    if (!('content' in first)) throw new Error('refused')
    const edited = first.content
      .replace('type: browser', 'type: browser\nowner: web-team')
      .replace('| GET | /posts | posts.index |', '| GET | /stale | posts.index |')
      .replace('One line per area to explore: one area, one posture, one sentence.', '- create a post with a 300-character title')
    const rewritten = renderFeatureDoc(edited, posts, map)
    if (!('content' in rewritten)) throw new Error('refused')
    expect(rewritten.content).not.toContain('/stale')
    expect(rewritten.content).toContain('owner: web-team')
    expect(rewritten.content).toContain('- create a post with a 300-character title')
  })

  test('refuses markers it cannot rewrite safely', () => {
    const broken = '# posts\n\n## Routes\n\n<!-- guren:browser routes -->\nold\n\n## Charters\n'
    expect(renderFeatureDoc(broken, posts, map)).toEqual({ problems: ['line 5: the block "routes" opens and never closes'] })
  })

  test('says what a plan leaves unplanned rather than inventing it', () => {
    const fixture: Fixture = { ...BLOG, routes: [...BLOG.routes, { node: route(5, 'POST', '/posts/:postId/comments', 'comments.store', 'show') }] }
    const planned = buildBrowserMap(graphOf(fixture), [{ file: 'comments.plan.json', plan: loadParsedCommentsPlan() }])
    const doc = renderFeatureDoc(undefined, feature(planned, 'posts'), planned)
    if (!('content' in doc)) throw new Error('refused')
    expect(doc.content).toContain('**AC-comments-2** (validation)')
    expect(doc.content).toContain('(message text not planned)')
    expect(doc.content).toContain('(button or link: check the page)')
    expect(doc.content).toContain('- validation (AC-comments-2): ')
  })

  test('folds multiline plan prose so the document reads back and reruns unchanged', () => {
    const plan = loadParsedCommentsPlan()
    plan.tasks[0]!.acceptance[1]!.description = 'Rejects an empty body\n## Details\n<!-- /guren:browser plan -->'
    const fixture: Fixture = { ...BLOG, routes: [...BLOG.routes, { node: route(5, 'POST', '/posts/:postId/comments', 'comments.store', 'show') }] }
    const planned = buildBrowserMap(graphOf(fixture), [{ file: 'comments.plan.json', plan }])
    const posts = feature(planned, 'posts')
    const first = renderFeatureDoc(undefined, posts, planned)
    if (!('content' in first)) throw new Error(`refused: ${first.problems.join('; ')}`)
    expect(first.content).toContain('(validation): Rejects an empty body ## Details <!-- /guren:browser plan -->')
    expect(renderFeatureDoc(first.content, posts, planned)).toEqual(first)
  })

  test('the index lists unassigned routes, unreached pages and kept orphans', () => {
    const index = renderIndexDoc(undefined, map, ['docs/browser/old.md'])
    if (!('content' in index)) throw new Error('refused')
    expect(index.content).toContain('| [posts](./posts.md) | GET /posts | 2 | 2 | none |')
    expect(index.content).toContain('- `Error`')
    expect(index.content).toContain('`POST /posts` (posts.store)')
    expect(index.content).toContain('- `docs/browser/old.md`')
  })
})

describe('approvedPlans', () => {
  test('reads only plans approved at their current hash, and reports what will not read', async () => {
    const workspace = await createTempWorkspace('guren-browser-map-plans-')
    try {
      const approved = JSON.stringify(loadApprovedCommentsPlan())
      await writeWorkspaceFiles(workspace.dir, {
        'docs/plans/approved/plan.json': approved,
        'docs/plans/unapproved/plan.json': approved,
        'docs/plans/garbled/plan.json': approved,
        'docs/plans/garbled/approvals.json': '{ not json',
        'draft.plan.json': JSON.stringify(loadCommentsPlan()),
        'broken.plan.json': '{',
      })
      await approvePlanFile(join(workspace.dir, 'docs/plans/approved/plan.json'))
      const { plans, unreadable } = await approvedPlans(workspace.dir)
      expect(plans.map((entry) => entry.file)).toEqual(['docs/plans/approved/plan.json'])
      expect(unreadable.map((entry) => entry.plan).sort()).toEqual(['broken.plan.json', 'docs/plans/garbled/plan.json'])
    } finally { await workspace.cleanup() }
  })
})
