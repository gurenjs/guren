import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DocsService } from '../../app/Services/DocsService.js'
import { PrebuiltDocsStore, shouldUsePrerendered } from '../../app/Services/DocsStore.js'
import { FsDocsStore } from '../../app/Services/FsDocsStore.js'

const repoDocsDir = resolve(import.meta.dirname, '../../../docs')

const fixtureData = {
  prerendered: true,
  docs: {
    en: {
      guides: {
        routing: {
          title: 'Routing',
          description: 'Define routes',
          raw: '# Routing\n\nDefine routes.',
          html: '<h1 id="routing">Routing</h1>\n<p>Define routes.</p>\n',
        },
      },
    },
  },
}

describe('PrebuiltDocsStore', () => {
  const store = new PrebuiltDocsStore(fixtureData)

  it('should list summaries from prerendered data', async () => {
    await expect(store.list('guides', 'en')).resolves.toEqual([
      { slug: 'routing', title: 'Routing', description: 'Define routes' },
    ])
  })

  it('should serve prerendered html and raw markdown', async () => {
    const doc = await store.getRendered('guides', 'routing', 'en')
    expect(doc?.html).toContain('<h1 id="routing">Routing</h1>')

    await expect(store.getRaw('guides', 'routing', 'en')).resolves.toBe(
      '# Routing\n\nDefine routes.',
    )
  })

  it('should return null and empty lists for missing content', async () => {
    await expect(store.getRendered('guides', 'missing', 'en')).resolves.toBeNull()
    await expect(store.getRaw('guides', 'routing', 'ja')).resolves.toBeNull()
    await expect(store.list('tutorials', 'en')).resolves.toEqual([])
  })
})

describe('DocsService with a prebuilt store', () => {
  const service = new DocsService(new PrebuiltDocsStore(fixtureData))

  it('should serve a known doc through getDoc and getRawMarkdown', async () => {
    const doc = await service.getDoc('guides', 'routing', 'en')
    expect(doc).toMatchObject({
      category: 'guides',
      slug: 'routing',
      title: 'Routing',
    })
    expect(doc?.html).toContain('Routing')

    await expect(service.getRawMarkdown('guides', 'routing', 'en')).resolves.toContain('# Routing')
  })

  it('should group listed docs into sections', async () => {
    const groups = await service.listDocs('en')
    const guides = groups.find((group) => group.category === 'guides')

    expect(guides?.docs.map((doc) => doc.slug)).toEqual(['routing'])
    expect(guides?.sections).toEqual([
      { title: 'The Basics', docs: [{ slug: 'routing', title: 'Routing', description: 'Define routes' }] },
    ])
  })
})

describe('FsDocsStore', () => {
  const store = new FsDocsStore(repoDocsDir)

  it('should list docs from the repository docs directory', async () => {
    const docs = await store.list('guides', 'en')
    const routing = docs.find((doc) => doc.slug === 'routing')

    expect(docs.length).toBeGreaterThan(0)
    expect(routing?.title.length).toBeGreaterThan(0)
  })

  it('should read raw markdown and render html for a known doc', async () => {
    const raw = await store.getRaw('guides', 'routing', 'en')
    expect(raw).toContain('# ')

    const doc = await store.getRendered('guides', 'routing', 'en')
    expect(doc?.html).toContain('<h1')
  })

  it('should return null for a missing doc', async () => {
    await expect(store.getRaw('guides', 'does-not-exist', 'en')).resolves.toBeNull()
    await expect(store.getRendered('guides', 'does-not-exist', 'en')).resolves.toBeNull()
  })
})

describe('shouldUsePrerendered', () => {
  const originalNodeEnv = process.env.NODE_ENV
  const originalOverride = process.env.GUREN_DOCS_PRERENDERED

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv
    if (originalOverride === undefined) {
      delete process.env.GUREN_DOCS_PRERENDERED
    } else {
      process.env.GUREN_DOCS_PRERENDERED = originalOverride
    }
  })

  it('should never use a stub module', () => {
    process.env.NODE_ENV = 'production'
    expect(shouldUsePrerendered(false)).toBe(false)
  })

  it('should use prerendered content in production', () => {
    process.env.NODE_ENV = 'production'
    expect(shouldUsePrerendered(true)).toBe(true)
  })

  it('should fall back to live rendering outside production', () => {
    process.env.NODE_ENV = 'test'
    delete process.env.GUREN_DOCS_PRERENDERED
    expect(shouldUsePrerendered(true)).toBe(false)
  })

  it('should honor the GUREN_DOCS_PRERENDERED override', () => {
    process.env.NODE_ENV = 'test'
    process.env.GUREN_DOCS_PRERENDERED = '1'
    expect(shouldUsePrerendered(true)).toBe(true)
  })
})
