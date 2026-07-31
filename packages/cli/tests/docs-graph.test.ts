import { describe, expect, it } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildDocsGraph, buildDocsGraphReport, renderDocsGraphMarkdown } from '../src/docs-graph'
import { createTempWorkspace } from './helpers'
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

describe('buildDocsGraphReport', () => {
  async function writeFixture(dir: string): Promise<void> {
    await mkdir(join(dir, 'docs/adr'), { recursive: true })
    await mkdir(join(dir, 'app/Models'), { recursive: true })
    await mkdir(join(dir, 'app/Http/Controllers'), { recursive: true })
    await writeFile(join(dir, 'package.json'), '{}', 'utf8')
    await writeFile(join(dir, 'app/Models/Post.ts'), 'export class Post {}\n', 'utf8')
    await writeFile(
      join(dir, 'app/Http/Controllers/PostController.ts'),
      'export class PostController {}\n',
      'utf8',
    )
    await writeFile(
      join(dir, 'docs/adr/0001-posts.md'),
      `---
type: adr
entities: [Post]
related: [app/Http/Controllers/PostController.ts]
---
# Posts are public
`,
      'utf8',
    )
    await writeFile(
      join(dir, 'docs/adr/0002-other.md'),
      '---\ntype: adr\n---\n# Unrelated decision\n',
      'utf8',
    )
  }

  it('returns the whole graph when no focus is given', async () => {
    const workspace = await createTempWorkspace('guren-cli-docs-graph-report-')
    try {
      await writeFixture(workspace.dir)

      const report = await buildDocsGraphReport({ cwd: workspace.dir })

      expect(report.focus).toEqual([])
      expect(report.query).toBeUndefined()
      expect(report.nodes.some((n) => n.id === 'docs/adr/0002-other.md')).toBe(true)
    } finally {
      await workspace.cleanup()
    }
  })

  it('narrows to a path neighborhood — the pre-rename impact question', async () => {
    const workspace = await createTempWorkspace('guren-cli-docs-graph-path-')
    try {
      await writeFixture(workspace.dir)

      const report = await buildDocsGraphReport({
        cwd: workspace.dir,
        path: 'app/Http/Controllers/PostController.ts',
      })

      expect(report.focus).toEqual(['app/Http/Controllers/PostController.ts'])
      expect(report.query).toEqual({ path: 'app/Http/Controllers/PostController.ts' })
      // The governing doc is pulled in; the unrelated doc is not.
      expect(report.nodes.some((n) => n.id === 'docs/adr/0001-posts.md')).toBe(true)
      expect(report.nodes.some((n) => n.id === 'docs/adr/0002-other.md')).toBe(false)
      expect(report.edges).toHaveLength(1)
    } finally {
      await workspace.cleanup()
    }
  })

  it('narrows to an entity neighborhood, case-insensitively', async () => {
    const workspace = await createTempWorkspace('guren-cli-docs-graph-entity-')
    try {
      await writeFixture(workspace.dir)

      const report = await buildDocsGraphReport({ cwd: workspace.dir, entity: 'post' })

      expect(report.focus).toEqual(['entity:Post'])
      expect(report.nodes.some((n) => n.id === 'docs/adr/0001-posts.md')).toBe(true)
      expect(report.nodes.some((n) => n.id === 'docs/adr/0002-other.md')).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })

  it('matches a file under a directory node', async () => {
    const workspace = await createTempWorkspace('guren-cli-docs-graph-dir-')
    try {
      const dir = workspace.dir
      await mkdir(join(dir, 'docs/spec'), { recursive: true })
      await writeFile(join(dir, 'package.json'), '{}', 'utf8')
      await writeFile(
        join(dir, 'docs/spec/domain.md'),
        '---\ntype: spec\n---\n# Domain Model\n',
        'utf8',
      )

      // app/Models/ is a derivation source label; a concrete file under
      // it should reach the spec views it feeds.
      const report = await buildDocsGraphReport({ cwd: dir, path: 'app/Models/Post.ts' })

      expect(report.focus).toContain('app/Models/')
      expect(report.nodes.some((n) => n.id === 'docs/spec/domain.md')).toBe(true)
    } finally {
      await workspace.cleanup()
    }
  })

  it('renders an empty-neighborhood message rather than an empty document', async () => {
    const workspace = await createTempWorkspace('guren-cli-docs-graph-empty-')
    try {
      await writeFixture(workspace.dir)

      const report = await buildDocsGraphReport({ cwd: workspace.dir, path: 'config/nope.md' })
      const markdown = renderDocsGraphMarkdown(report)

      expect(report.nodes).toHaveLength(0)
      expect(report.focus).toEqual([])
      expect(report.query).toEqual({ path: 'config/nope.md' })
      expect(markdown).toContain('Nothing in the docs graph references "config/nope.md".')
    } finally {
      await workspace.cleanup()
    }
  })

  it('reaches spec views from module paths via the drift-gate patterns', async () => {
    const workspace = await createTempWorkspace('guren-cli-docs-graph-module-')
    try {
      const dir = workspace.dir
      await mkdir(join(dir, 'docs/spec'), { recursive: true })
      await writeFile(join(dir, 'package.json'), '{}', 'utf8')
      await writeFile(join(dir, 'docs/spec/er.md'), '---\ntype: spec\n---\n# ER Diagram\n', 'utf8')

      // The node label collapses module schemas to `db/schema.ts`; the
      // SPEC_VIEWS pattern is what says this module file feeds the view.
      const report = await buildDocsGraphReport({ cwd: dir, path: 'modules/billing/db/schema.ts' })

      expect(report.focus).toContain('db/schema.ts')
      expect(report.nodes.some((n) => n.id === 'docs/spec/er.md')).toBe(true)
    } finally {
      await workspace.cleanup()
    }
  })

  it('matches glob-form related entries and normalizes the query path', async () => {
    const workspace = await createTempWorkspace('guren-cli-docs-graph-glob-')
    try {
      const dir = workspace.dir
      await mkdir(join(dir, 'docs'), { recursive: true })
      await mkdir(join(dir, 'modules/billing'), { recursive: true })
      await writeFile(join(dir, 'package.json'), '{}', 'utf8')
      await writeFile(join(dir, 'modules/billing/routes.ts'), 'export {}\n', 'utf8')
      await writeFile(
        join(dir, 'docs/billing.md'),
        '---\ntype: context\nrelated: ["modules/billing/**"]\n---\n# Billing\n',
        'utf8',
      )

      const report = await buildDocsGraphReport({ cwd: dir, path: './modules/billing/routes.ts' })

      expect(report.focus).toContain('modules/billing/**')
      expect(report.nodes.some((n) => n.id === 'docs/billing.md')).toBe(true)
    } finally {
      await workspace.cleanup()
    }
  })

  it('rejects narrowing by entity and path at once', async () => {
    const workspace = await createTempWorkspace('guren-cli-docs-graph-both-')
    try {
      await writeFixture(workspace.dir)

      await expect(
        buildDocsGraphReport({ cwd: workspace.dir, entity: 'Post', path: 'app/Models/Post.ts' }),
      ).rejects.toThrow('either entity or path')
    } finally {
      await workspace.cleanup()
    }
  })

  it('renders verdict markers on broken relations', async () => {
    const workspace = await createTempWorkspace('guren-cli-docs-graph-verdict-')
    try {
      const dir = workspace.dir
      await mkdir(join(dir, 'docs'), { recursive: true })
      await writeFile(join(dir, 'package.json'), '{}', 'utf8')
      await writeFile(
        join(dir, 'docs/broken.md'),
        '---\ntype: context\nrelated: [app/Services/Gone.ts]\n---\n# Broken\n',
        'utf8',
      )

      const report = await buildDocsGraphReport({ cwd: dir })
      const markdown = renderDocsGraphMarkdown(report)

      expect(markdown).toContain('[FAIL]')
    } finally {
      await workspace.cleanup()
    }
  })
})
