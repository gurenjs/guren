import { describe, expect, it } from 'bun:test'
import { buildDocsGraph } from '../src/docs-graph'
import type { DocRef } from '../src/docs-index'
import type { CheckResult } from '../src/check-result'

function doc(path: string, overrides: Partial<DocRef> = {}): DocRef {
  return {
    path,
    module: null,
    tags: [],
    entities: [],
    related: [],
    verified: [],
    links: [],
    hasFrontmatter: true,
    ...overrides,
  }
}

function failResult(key: string): CheckResult {
  return { key, title: key, status: 'fail', message: 'broken' }
}

function warnResult(key: string): CheckResult {
  return { key, title: key, status: 'warn', message: 'missing' }
}

describe('buildDocsGraph', () => {
  it('joins docs, entities, and related paths with verdicts from the check results', () => {
    const adr = doc('docs/adr/0001-billing.md', {
      title: 'Billing cycle',
      type: 'adr',
      entities: ['Invoice', 'Ghost'],
      related: ['app/Http/Controllers/InvoiceController.ts'],
    })
    const { nodes, edges } = buildDocsGraph(
      [adr],
      [failResult('docs-entity:docs/adr/0001-billing.md:Ghost')],
    )

    expect(nodes).toContainEqual({
      id: 'docs/adr/0001-billing.md',
      kind: 'doc',
      label: 'Billing cycle',
      docType: 'adr',
    })
    expect(nodes).toContainEqual({ id: 'entity:Invoice', kind: 'entity', label: 'Invoice' })
    expect(nodes).toContainEqual({
      id: 'app/Http/Controllers/InvoiceController.ts',
      kind: 'code',
      label: 'InvoiceController.ts',
    })

    const ghost = edges.find((e) => e.to === 'entity:Ghost')
    expect(ghost?.verdict).toBe('fail')
    const invoice = edges.find((e) => e.to === 'entity:Invoice')
    expect(invoice?.verdict).toBe('pass')
    expect(invoice?.relation).toBe('governs')
  })

  it('joins body links between docs as doc-to-doc edges', () => {
    const first = doc('docs/adr/0001-first.md', { links: ['/adr/0002-second.md'] })
    const second = doc('docs/adr/0002-second.md')

    const { nodes, edges } = buildDocsGraph([first, second], [])

    const edge = edges.find((e) => e.relation === 'links')
    expect(edge).toEqual({
      from: 'docs/adr/0001-first.md',
      to: 'docs/adr/0002-second.md',
      relation: 'links',
      verdict: 'pass',
    })
    // No duplicate code node for the linked doc
    expect(nodes.filter((n) => n.id === 'docs/adr/0002-second.md')).toHaveLength(1)
  })

  it('keys body links to code by their resolved app-root path', () => {
    const ref = doc('docs/adr/0001-first.md', { links: ['../../config/billing.ts', './missing.md'] })

    const { nodes, edges } = buildDocsGraph([ref], [
      warnResult('docs-link:docs/adr/0001-first.md:./missing.md'),
    ])

    expect(nodes).toContainEqual({ id: 'config/billing.ts', kind: 'code', label: 'billing.ts' })
    const missing = edges.find((e) => e.to === 'docs/adr/missing.md')
    expect(missing?.verdict).toBe('warn')
  })

  it('adds derivation edges for generated spec views from SPEC_VIEWS labels', () => {
    const spec = doc('docs/spec/er.md', { title: 'ER Diagram', type: 'spec' })

    const { nodes, edges } = buildDocsGraph([spec], [])

    expect(nodes).toContainEqual({ id: 'db/schema.ts', kind: 'code', label: 'schema.ts' })
    expect(edges).toContainEqual({
      from: 'db/schema.ts',
      to: 'docs/spec/er.md',
      relation: 'derives',
      verdict: 'pass',
    })
  })

  it('adds no derivation edges when no spec views are present', () => {
    const { edges } = buildDocsGraph([doc('docs/adr/0001-x.md')], [])

    expect(edges.filter((e) => e.relation === 'derives')).toHaveLength(0)
  })

  it('shares one node when several docs declare the same target', () => {
    const a = doc('docs/a.md', { related: ['app/Models/Post.ts'] })
    const b = doc('docs/b.md', { related: ['app/Models/Post.ts'] })

    const { nodes, edges } = buildDocsGraph([a, b], [])

    expect(nodes.filter((n) => n.id === 'app/Models/Post.ts')).toHaveLength(1)
    expect(edges.filter((e) => e.to === 'app/Models/Post.ts')).toHaveLength(2)
  })
})
