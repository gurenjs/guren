import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { parseDocFrontmatter, scanDocs, extractDocsTags, buildEntityDocIndex } from '../src/docs-index'
import { createTempWorkspace } from './helpers'

describe('parseDocFrontmatter', () => {
  it('parses scalars, inline arrays, and block lists', () => {
    const parsed = parseDocFrontmatter(`---
kind: adr
status: accepted
entities: [User, Invoice]
related:
  - app/Models/Invoice.ts
  - modules/billing/**
last_reviewed: 2026-07-25
---

# Billing cycle
`)

    expect(parsed).not.toBeNull()
    expect(parsed!.data.kind).toBe('adr')
    expect(parsed!.data.status).toBe('accepted')
    expect(parsed!.data.entities).toEqual(['User', 'Invoice'])
    expect(parsed!.data.related).toEqual(['app/Models/Invoice.ts', 'modules/billing/**'])
    expect(parsed!.data.last_reviewed).toBe('2026-07-25')
    expect(parsed!.body).toContain('# Billing cycle')
  })

  it('strips quotes from values', () => {
    const parsed = parseDocFrontmatter(`---
kind: "adr"
entities: ['User']
---
body`)

    expect(parsed!.data.kind).toBe('adr')
    expect(parsed!.data.entities).toEqual(['User'])
  })

  it('strips inline YAML comments from unquoted values', () => {
    const parsed = parseDocFrontmatter(`---
status: superseded # replaced by 0009
entities: [Post] # main entity
related:
  - app/Models/Post.ts # the model
---
`)

    expect(parsed!.data.status).toBe('superseded')
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

describe('scanDocs', () => {
  it('scans root docs/ and module docs/, extracting titles', async () => {
    const workspace = await createTempWorkspace('guren-cli-docs-scan-')

    try {
      const dir = workspace.dir
      await mkdir(join(dir, 'docs/adr'), { recursive: true })
      await mkdir(join(dir, 'modules/billing/docs'), { recursive: true })
      await writeFile(
        join(dir, 'docs/adr/0001-billing-cycle.md'),
        `---
kind: adr
status: accepted
entities: [Post]
---

# Billing cycle is end-of-month
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
      expect(adr?.kind).toBe('adr')
      expect(adr?.entities).toEqual(['Post'])
      expect(adr?.hasFrontmatter).toBe(true)

      const moduleDoc = refs.find((r) => r.path === 'modules/billing/docs/context.md')
      expect(moduleDoc?.module).toBe('billing')
      expect(moduleDoc?.hasFrontmatter).toBe(false)
      expect(moduleDoc?.title).toBe('Billing context')
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
        entities: ['Post', 'User'],
        related: [],
        hasFrontmatter: true,
      },
      {
        path: 'docs/b.md',
        module: null,
        entities: ['Post'],
        related: [],
        hasFrontmatter: true,
      },
    ])

    expect(index.get('post')?.map((r) => r.path)).toEqual(['docs/a.md', 'docs/b.md'])
    expect(index.get('user')?.map((r) => r.path)).toEqual(['docs/a.md'])
  })
})
