import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import {
  parseDocFrontmatter,
  scanDocs,
  extractDocsTags,
  extractMarkdownLinks,
  buildEntityDocIndex,
} from '../src/docs-index'
import { createTempWorkspace } from './helpers'

describe('parseDocFrontmatter', () => {
  it('parses scalars, inline arrays, and block lists', () => {
    const parsed = parseDocFrontmatter(`---
type: adr
status: stable
entities: [User, Invoice]
related:
  - app/Models/Invoice.ts
  - modules/billing/**
stale_after: 2026-07-25
---

# Billing cycle
`)

    expect(parsed).not.toBeNull()
    expect(parsed!.data.type).toBe('adr')
    expect(parsed!.data.status).toBe('stable')
    expect(parsed!.data.entities).toEqual(['User', 'Invoice'])
    expect(parsed!.data.related).toEqual(['app/Models/Invoice.ts', 'modules/billing/**'])
    expect(parsed!.data.stale_after).toBe('2026-07-25')
    expect(parsed!.body).toContain('# Billing cycle')
  })

  it('strips quotes from values', () => {
    const parsed = parseDocFrontmatter(`---
type: "adr"
entities: ['User']
---
body`)

    expect(parsed!.data.type).toBe('adr')
    expect(parsed!.data.entities).toEqual(['User'])
  })

  it('strips inline YAML comments from unquoted values', () => {
    const parsed = parseDocFrontmatter(`---
status: deprecated # replaced by 0009
entities: [Post] # main entity
related:
  - app/Models/Post.ts # the model
---
`)

    expect(parsed!.data.status).toBe('deprecated')
    expect(parsed!.data.entities).toEqual(['Post'])
    expect(parsed!.data.related).toEqual(['app/Models/Post.ts'])
  })

  it('respects quoted commas inside inline arrays', () => {
    const parsed = parseDocFrontmatter(`---
related: ["config/foo,bar.json", app/Models/Post.ts]
---
`)

    expect(parsed!.data.related).toEqual(['config/foo,bar.json', 'app/Models/Post.ts'])
  })

  it('returns null when there is no frontmatter', () => {
    expect(parseDocFrontmatter('# Just a heading\n')).toBeNull()
  })

  it('ignores unknown keys and malformed lines without failing', () => {
    const parsed = parseDocFrontmatter(`---
custom_field: hello
:::garbage:::
entities: []
---
`)

    expect(parsed!.data.custom_field).toBe('hello')
    expect(parsed!.data.entities).toEqual([])
  })
})

describe('extractMarkdownLinks', () => {
  it('extracts local link and image targets, stripping fragments', () => {
    const links = extractMarkdownLinks(`
See [orders](/adr/0002-orders.md#joins) and [the model](../../app/Models/Post.ts).
![diagram](./diagram.png)
`)

    expect(links).toEqual(['/adr/0002-orders.md', '../../app/Models/Post.ts', './diagram.png'])
  })

  it('skips external URLs, bare anchors, and links inside code', () => {
    const links = extractMarkdownLinks(`
[dashboard](https://example.com/dash) [mail](mailto:a@b.c) [above](#schema)

\`\`\`markdown
[example](/tables/customers.md)
\`\`\`

Inline \`[code](/not-a-link.md)\` too, but [real](./real.md).
`)

    expect(links).toEqual(['./real.md'])
  })

  it('deduplicates repeated targets', () => {
    expect(extractMarkdownLinks('[a](./x.md) and [b](./x.md#frag)')).toEqual(['./x.md'])
  })
})

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
        links: [],
        hasFrontmatter: true,
      },
    ])

    expect(index.get('post')?.map((r) => r.path)).toEqual(['docs/a.md', 'docs/b.md'])
    expect(index.get('user')?.map((r) => r.path)).toEqual(['docs/a.md'])
  })
})
