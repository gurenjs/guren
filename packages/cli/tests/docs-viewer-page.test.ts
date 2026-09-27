import { describe, expect, test } from 'bun:test'

import { docsViewerAssetPath, docsViewerShell } from '../src/docs-viewer'
import { groupTests, idPattern, kindOf, withOpenPlans, worstVerdict, type GraphView, type ViewEdge, type ViewNode } from '../src/docs-viewer-page/model'
import type { DocsViewerOpenPlan } from '../src/docs-viewer-plans'

const shell = docsViewerShell()
const bundle = [...shell.matchAll(/<script>\n([\s\S]*?)<\/script>/g)].at(-1)?.[1] ?? ''

describe('the docs viewer shell', () => {
  test('should be the template with its TypeScript bundled in as one classic script', () => {
    expect(shell).toContain('<title>Guren docs</title>')
    expect(shell).not.toContain('__GUREN_DOCS_VIEWER_SCRIPT__')
    expect(bundle.startsWith('"use strict";\n(() => {')).toBe(true)
    expect(bundle).not.toMatch(/^\s*(import|export)\b/m)
    expect(bundle).not.toMatch(/\brequire\(|\bimport\.meta\b/)
  })

  test('should bundle only the page modules: what it imports from the CLI or a package is types', () => {
    // The bundler names every module it inlines, a package's `.js` included, in a comment line of its own.
    const modules = [...bundle.matchAll(/^ {2}\/\/ (\S+)$/gm)].map((match) => match[1])
    expect(modules.length).toBeGreaterThan(0)
    expect(modules.filter((path) => path.includes('/'))).toEqual([])
  })

  test('should name no path of the machine that built it', () => {
    expect(bundle).not.toContain(import.meta.dir.split('/').slice(0, 3).join('/'))
  })

  test('should be written by the build where the server reads it', () => {
    expect(docsViewerAssetPath().endsWith('assets/docs-viewer/index.html')).toBe(true)
  })
})

const node = (id: string, kind: ViewNode['kind'], extra: Partial<ViewNode> = {}): ViewNode => ({ id, kind, label: id.replace(/^\w+:/, ''), ...extra })
const edge = (from: string, to: string, verdict: ViewEdge['verdict'] = 'pass'): ViewEdge => ({ from, to, relation: 'verifies', verdict })

describe('groupTests', () => {
  const view: GraphView = {
    nodes: [
      node('docs/entities/Post.md', 'doc'),
      node('docs/plans/posts.md', 'doc', { docType: 'plan' }),
      node('test:AC-posts-1', 'test'),
      node('test:AC-posts-2', 'test'),
      node('test:AC-posts-3', 'test'),
      node('test:AC-orphan-1', 'test'),
    ],
    edges: [
      edge('test:AC-posts-1', 'docs/entities/Post.md'),
      edge('test:AC-posts-1', 'docs/plans/posts.md'),
      edge('test:AC-posts-2', 'docs/entities/Post.md', 'warn'),
      edge('test:AC-posts-2', 'docs/plans/posts.md'),
      edge('test:AC-posts-3', 'docs/entities/Post.md'),
    ],
  }

  test('should collapse tests verifying the same documents into one node carrying each id and verdict', () => {
    const grouped = groupTests(view)

    const group = grouped.nodes.find((entry) => entry.members !== undefined)!
    expect(group.label).toBe('AC-posts-*')
    expect(group.members).toEqual([
      { id: 'test:AC-posts-1', label: 'AC-posts-1', verdict: 'pass' },
      { id: 'test:AC-posts-2', label: 'AC-posts-2', verdict: 'warn' },
    ])
    expect(grouped.edges.filter((entry) => entry.from === group.id)).toEqual([
      { from: group.id, to: 'docs/entities/Post.md', relation: 'verifies', verdict: 'warn' },
      { from: group.id, to: 'docs/plans/posts.md', relation: 'verifies', verdict: 'pass' },
    ])
  })

  test('should leave a test alone when no other shares its documents, and one that verifies nothing', () => {
    const ids = groupTests(view).nodes.map((entry) => entry.id)

    expect(ids).toContain('test:AC-posts-3')
    expect(ids).toContain('test:AC-orphan-1')
    expect(ids).not.toContain('test:AC-posts-1')
  })
})

describe('withOpenPlans', () => {
  const plan = { file: 'docs/plans/rsvp.plan.json', title: 'RSVP', standing: 'draft', entities: ['Meetup', 'Rsvp'] } as DocsViewerOpenPlan

  test('should add a node per open plan linked to its entities, adding an entity no doc names yet', () => {
    const result = withOpenPlans({ nodes: [node('entity:Meetup', 'entity')], edges: [] }, [plan])

    expect(result.nodes.map((entry) => [entry.id, entry.kind])).toEqual([
      ['entity:Meetup', 'entity'],
      ['plan:docs/plans/rsvp.plan.json', 'openplan'],
      ['entity:Rsvp', 'entity'],
    ])
    expect(result.edges.map((entry) => [entry.from, entry.to, entry.relation])).toEqual([
      ['plan:docs/plans/rsvp.plan.json', 'entity:Meetup', 'plans'],
      ['plan:docs/plans/rsvp.plan.json', 'entity:Rsvp', 'plans'],
    ])
  })
})

describe('the graph helpers', () => {
  test('kindOf should toggle spec and plan documents and open plans apart from other docs', () => {
    expect(kindOf(node('a', 'doc', { docType: 'adr' }))).toBe('doc')
    expect(kindOf(node('b', 'doc', { docType: 'spec' }))).toBe('spec')
    expect(kindOf(node('c', 'doc', { docType: 'plan' }))).toBe('plan')
    expect(kindOf(node('d', 'openplan'))).toBe('plan')
  })

  test('idPattern should cut the shared prefix at its last dash', () => {
    expect(idPattern(['AC-meetups-edit-1', 'AC-meetups-host-2'])).toBe('AC-meetups-*')
    expect(idPattern(['AC-a-1', 'AC-b-1'])).toBe('AC-*')
  })

  test('worstVerdict should rank fail over warn over pass', () => {
    expect(worstVerdict([])).toBe('pass')
    expect(worstVerdict(['pass', 'warn'])).toBe('warn')
    expect(worstVerdict(['warn', 'fail', 'pass'])).toBe('fail')
  })
})
