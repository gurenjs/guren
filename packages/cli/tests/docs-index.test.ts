import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { scanDocs, extractDocsTags, buildEntityDocIndex } from '../src/docs-index'
import { createTempWorkspace } from './helpers'

describe('scanDocs', () => {
  it('scans root docs/ and module docs/, extracting OKF frontmatter', async () => {
    const workspace = await createTempWorkspace('guren-cli-docs-scan-')

    try {
      const dir = workspace.dir
      await mkdir(join(dir, 'docs/adr'), { recursive: true })
      await mkdir(join(dir, 'modules/billing/docs'), { recursive: true })
      await writeFile(
        join(dir, 'docs/adr/0001-billing-cycle.md'),
        `---
type: adr
status: stable
description: Billing runs end-of-month.
tags: [billing, finance]
entities: [Post]
generated: { by: my-agent/1.0, at: 2026-07-25T09:00:00Z }
verified:
  - { by: human:ada, at: 2026-07-26T09:00:00Z }
  - { by: process:nightly, at: 2026-07-27T02:00:00Z }
stale_after: 2026-12-31
---

# Billing cycle is end-of-month

Linked to [context](/context.md).
`,
        'utf8',
      )
      await writeFile(
        join(dir, 'modules/billing/docs/context.md'),
        '# Billing context\n\nNo frontmatter here.\n',
        'utf8',
      )

      const refs = await scanDocs(dir)

      expect(refs).toHaveLength(2)
      const adr = refs.find((r) => r.path === 'docs/adr/0001-billing-cycle.md')
      expect(adr?.module).toBeNull()
      expect(adr?.title).toBe('Billing cycle is end-of-month')
      expect(adr?.type).toBe('adr')
      expect(adr?.status).toBe('stable')
      expect(adr?.description).toBe('Billing runs end-of-month.')
      expect(adr?.tags).toEqual(['billing', 'finance'])
      expect(adr?.entities).toEqual(['Post'])
      expect(adr?.generated).toEqual({ by: 'my-agent/1.0', at: '2026-07-25T09:00:00Z' })
      expect(adr?.verified).toEqual([
        { by: 'human:ada', at: '2026-07-26T09:00:00Z' },
        { by: 'process:nightly', at: '2026-07-27T02:00:00Z' },
      ])
      expect(adr?.staleAfter).toBe('2026-12-31')
      expect(adr?.links).toEqual(['/context.md'])
      expect(adr?.hasFrontmatter).toBe(true)

      const moduleDoc = refs.find((r) => r.path === 'modules/billing/docs/context.md')
      expect(moduleDoc?.module).toBe('billing')
      expect(moduleDoc?.hasFrontmatter).toBe(false)
      expect(moduleDoc?.title).toBe('Billing context')
    } finally {
      await workspace.cleanup()
    }
  })

  it('prefers frontmatter title and treats a bare verified mapping as one entry', async () => {
    const workspace = await createTempWorkspace('guren-cli-docs-title-')

    try {
      const dir = workspace.dir
      await mkdir(join(dir, 'docs'), { recursive: true })
      await writeFile(
        join(dir, 'docs/billing.md'),
        `---
type: context
title: Billing overview
verified: { by: human:ada, at: 2026-07-26T09:00:00Z }
---

# A different heading
`,
        'utf8',
      )

      const [ref] = await scanDocs(dir)

      expect(ref.title).toBe('Billing overview')
      expect(ref.verified).toEqual([{ by: 'human:ada', at: '2026-07-26T09:00:00Z' }])
    } finally {
      await workspace.cleanup()
    }
  })

  it('skips the reserved index.md and log.md filenames', async () => {
    const workspace = await createTempWorkspace('guren-cli-docs-reserved-')

    try {
      const dir = workspace.dir
      await mkdir(join(dir, 'docs/adr'), { recursive: true })
      await writeFile(join(dir, 'docs/index.md'), '# Listing\n', 'utf8')
      await writeFile(join(dir, 'docs/adr/log.md'), '# Update log\n', 'utf8')
      await writeFile(join(dir, 'docs/adr/0001-x.md'), '---\ntype: adr\n---\n\n# X\n', 'utf8')

      const refs = await scanDocs(dir)

      expect(refs.map((r) => r.path)).toEqual(['docs/adr/0001-x.md'])
    } finally {
      await workspace.cleanup()
    }
  })

  it('resolves to an empty list when no docs directories exist', async () => {
    const workspace = await createTempWorkspace('guren-cli-docs-empty-')

    try {
      await writeFile(join(workspace.dir, 'package.json'), '{}', 'utf8')
      expect(await scanDocs(workspace.dir)).toEqual([])
    } finally {
      await workspace.cleanup()
    }
  })
})

describe('extractDocsTags', () => {
  it('extracts @docs tags from JSDoc comments', () => {
    const tags = extractDocsTags(`/**
 * @docs docs/adr/0007-billing-cycle.md
 */
export class Invoice {}
`)

    expect(tags).toEqual(['docs/adr/0007-billing-cycle.md'])
  })

  it('deduplicates and handles multiple tags', () => {
    const tags = extractDocsTags(`
/** @docs docs/a.md */
/** @docs docs/b.md */
/** @docs docs/a.md */
`)

    expect(tags).toEqual(['docs/a.md', 'docs/b.md'])
  })

  it('returns an empty list when no tags exist', () => {
    expect(extractDocsTags('export class Post {}')).toEqual([])
  })
})

describe('buildEntityDocIndex', () => {
  it('indexes docs by lowercased entity name', () => {
    const index = buildEntityDocIndex([
      {
        path: 'docs/a.md',
        module: null,
        tags: [],
        entities: ['Post', 'User'],
        related: [],
        verified: [],
        issues: [],
        malformedIssues: [],
        links: [],
        hasFrontmatter: true,
      },
      {
        path: 'docs/b.md',
        module: null,
        tags: [],
        entities: ['Post'],
        related: [],
        verified: [],
        issues: [],
        malformedIssues: [],
        links: [],
        hasFrontmatter: true,
      },
    ])

    expect(index.get('post')?.map((r) => r.path)).toEqual(['docs/a.md', 'docs/b.md'])
    expect(index.get('user')?.map((r) => r.path)).toEqual(['docs/a.md'])
  })
})
