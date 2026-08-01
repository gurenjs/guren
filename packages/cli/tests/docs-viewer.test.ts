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

  it('drops an HTML comment standing in front of the H1, however many precede it', async () => {
    const workspace = await createTempWorkspace('guren-cli-docs-viewer-comment-')
    try {
      const dir = workspace.dir
      await mkdir(join(dir, 'docs/adr'), { recursive: true })
      await writeFile(join(dir, 'package.json'), '{}', 'utf8')
      await writeFile(
        join(dir, 'docs/adr/0001-posts.md'),
        `---\ntype: adr\nstatus: stable\n---\n\n<!-- one --> <!-- two -->\n# Posts are public\n\nEveryone can read.\n`,
        'utf8',
      )

      const data = await buildDocsViewerData(dir)

      // The H1 stands behind two comments, so it is reachable only through the
      // optional comment prefix — and only by looking past the first `-->`,
      // which is the step that decides where the dropped span ends.
      const [doc] = data.docs
      expect(doc.html).not.toContain('Posts are public')
      expect(doc.html).toContain('Everyone can read.')
    } finally {
      await workspace.cleanup()
    }
  })

  it('leaves a body that opens comments it never closes untouched', async () => {
    const workspace = await createTempWorkspace('guren-cli-docs-viewer-unclosed-')
    try {
      const dir = workspace.dir
      await mkdir(join(dir, 'docs/adr'), { recursive: true })
      await writeFile(join(dir, 'package.json'), '{}', 'utf8')
      // Every one of these line starts used to re-scan the rest of the file
      // looking for a `-->` that is not there, which is the quadratic case.
      const noise = '<!-- generated, do not edit\n'.repeat(4_000)
      await writeFile(
        join(dir, 'docs/adr/0001-posts.md'),
        `---\ntype: adr\nstatus: stable\n---\n\n${noise}\nEveryone can read.\n`,
        'utf8',
      )

      const data = await buildDocsViewerData(dir)

      // Nothing to drop: no heading is reachable behind those openers, so the
      // prose after them has to survive rather than be swallowed as a heading.
      expect(data.docs[0].html).toContain('Everyone can read.')
    } finally {
      await workspace.cleanup()
    }
  })
})

describe('buildDocsViewerData link resolution', () => {
  it('emits the app-root path a body link resolves to, fragments included', async () => {
    const workspace = await createTempWorkspace('guren-cli-docs-viewer-links-')
    try {
      const dir = workspace.dir
      await mkdir(join(dir, 'docs/adr'), { recursive: true })
      await writeFile(join(dir, 'package.json'), '{}', 'utf8')
      await writeFile(
        join(dir, 'docs/adr/0001-first.md'),
        `---
type: adr
---

# First

Superseded by [the second](/adr/0002-second.md#context) and see
[the site](https://example.com).
`,
        'utf8',
      )
      await writeFile(join(dir, 'docs/adr/0002-second.md'), '---\ntype: adr\n---\n\n# Second\n', 'utf8')

      const data = await buildDocsViewerData(dir)
      const first = data.docs.find((doc) => doc.path === 'docs/adr/0001-first.md')!

      // The fragment is dropped so the target matches a graph node id;
      // external URLs stay verbatim.
      expect(first.html).toContain('data-target="docs/adr/0002-second.md"')
      expect(first.html).toContain('data-target="https://example.com"')
      expect(data.nodes.some((node) => node.id === 'docs/adr/0002-second.md')).toBe(true)
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
