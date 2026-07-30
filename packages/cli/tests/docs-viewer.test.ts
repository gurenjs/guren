import { mkdir, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { buildDocsViewerData, docTrustTier, docsViewerAssetPath } from '../src/docs-viewer'
import { createTempWorkspace } from './helpers'

describe('docTrustTier', () => {
  it('derives the OKF trust tier from verified actors', () => {
    expect(docTrustTier({ verified: [] })).toBe('unverified')
    expect(docTrustTier({ verified: [{ by: 'process:nightly', at: '2026-07-01T00:00:00Z' }] })).toBe(
      'machine-confirmed',
    )
    expect(
      docTrustTier({
        verified: [
          { by: 'process:nightly', at: '2026-07-01T00:00:00Z' },
          { by: 'human:ada', at: '2026-07-02T00:00:00Z' },
        ],
      }),
    ).toBe('human-reviewed')
  })
})

describe('buildDocsViewerData', () => {
  it('bundles graph, frontmatter, and rendered bodies in one payload', async () => {
    const workspace = await createTempWorkspace('guren-cli-docs-viewer-')
    try {
      const dir = workspace.dir
      await mkdir(join(dir, 'docs/adr'), { recursive: true })
      await mkdir(join(dir, 'app/Models'), { recursive: true })
      await writeFile(join(dir, 'package.json'), '{}', 'utf8')
      await writeFile(join(dir, 'app/Models/Post.ts'), 'export class Post {}\n', 'utf8')
      await writeFile(
        join(dir, 'docs/adr/0001-posts.md'),
        `---
type: adr
status: stable
entities: [Post]
verified: { by: human:ada, at: 2026-07-25T09:00:00Z }
---

# Posts are public

## Context

Everyone can read.
`,
        'utf8',
      )

      const data = await buildDocsViewerData(dir)

      expect(data.docs).toHaveLength(1)
      const [doc] = data.docs
      expect(doc.path).toBe('docs/adr/0001-posts.md')
      expect(doc.type).toBe('adr')
      expect(doc.trustTier).toBe('human-reviewed')
      // Body H1 is dropped; the rest renders
      expect(doc.html).not.toContain('Posts are public')
      expect(doc.html).toContain('<h3>Context</h3>')
      expect(doc.html).toContain('<p>Everyone can read.</p>')

      expect(data.nodes.some((n) => n.id === 'entity:Post')).toBe(true)
      expect(data.edges).toContainEqual({
        from: 'docs/adr/0001-posts.md',
        to: 'entity:Post',
        relation: 'governs',
        verdict: 'pass',
      })
    } finally {
      await workspace.cleanup()
    }
  })
})

describe('docsViewerAssetPath', () => {
  it('points at the shipped UI shell', async () => {
    const path = docsViewerAssetPath()
    expect(path.endsWith('assets/docs-viewer/index.html')).toBe(true)
    await access(path)
  })
})
