import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { DocsService } from '../../app/Services/DocsService.js'
import {
  AssetDocsStore,
  createWorkersAssetReader,
  DocsAssetUnavailableError,
  type AssetReader,
} from '../../app/Services/DocsStore.js'
import { shouldUsePrerendered } from '../../app/Services/docs-config.js'
import { FsDocsStore } from '../../app/Services/FsDocsStore.js'
import { createPublicFileReader } from '../../app/Services/public-file-reader.js'

const repoDocsDir = resolve(import.meta.dirname, '../../../docs')

const manifest = {
  prerendered: true,
  docs: {
    en: {
      guides: {
        routing: { title: 'Routing', description: 'Define routes' },
        orphan: { title: 'Orphan' },
      },
    },
    ja: {
      guides: {
        routing: { title: 'ルーティング' },
      },
    },
  },
}

const files = new Map<string, string>([
  [
    '/_docs/en/guides/routing.json',
    JSON.stringify({
      title: 'Routing',
      description: 'Define routes',
      html: '<h1 id="routing">Routing</h1>\n<p>Define routes.</p>\n',
    }),
  ],
  ['/docs/guides/routing.md', '# Routing\n\nDefine routes.'],
  ['/docs/ja/guides/routing.md', '# ルーティング\n'],
  ['/llms-full.txt', '# Guren — Full Documentation\n'],
])

function mapReader(): { read: AssetReader; paths: string[] } {
  const paths: string[] = []
  return {
    paths,
    read: async (path) => {
      paths.push(path)
      return files.get(path) ?? null
    },
  }
}

describe('AssetDocsStore', () => {
  it('should list summaries from the manifest without reading any asset', async () => {
    const { read, paths } = mapReader()
    const store = new AssetDocsStore(manifest, read)

    await expect(store.list('guides', 'en')).resolves.toEqual([
      { slug: 'routing', title: 'Routing', description: 'Define routes' },
      { slug: 'orphan', title: 'Orphan' },
    ])
    expect(paths).toEqual([])
  })

  it('should read the rendered fragment and the markdown from their public paths', async () => {
    const { read, paths } = mapReader()
    const store = new AssetDocsStore(manifest, read)

    const doc = await store.getRendered('guides', 'routing', 'en')
    expect(doc).toEqual({
      slug: 'routing',
      title: 'Routing',
      description: 'Define routes',
      html: '<h1 id="routing">Routing</h1>\n<p>Define routes.</p>\n',
    })

    await expect(store.getRaw('guides', 'routing', 'en')).resolves.toBe('# Routing\n\nDefine routes.')
    await expect(store.getRaw('guides', 'routing', 'ja')).resolves.toBe('# ルーティング\n')
    expect(paths).toEqual([
      '/_docs/en/guides/routing.json',
      '/docs/guides/routing.md',
      '/docs/ja/guides/routing.md',
    ])
  })

  it('should answer null for a slug the manifest lacks, without reading', async () => {
    const { read, paths } = mapReader()
    const store = new AssetDocsStore(manifest, read)

    await expect(store.getRendered('guides', 'missing', 'en')).resolves.toBeNull()
    await expect(store.getRaw('tutorials', 'routing', 'en')).resolves.toBeNull()
    await expect(store.list('tutorials', 'en')).resolves.toEqual([])
    expect(paths).toEqual([])
  })

  // A manifest entry without its file is a broken build, not a missing page.
  it('should refuse with a 503 error when the manifest names a file that is not there', async () => {
    const store = new AssetDocsStore(manifest, mapReader().read)

    await expect(store.getRendered('guides', 'orphan', 'en')).rejects.toBeInstanceOf(
      DocsAssetUnavailableError,
    )
    await expect(store.getRaw('guides', 'orphan', 'en')).rejects.toMatchObject({
      statusCode: 503,
      message: expect.stringContaining('/docs/guides/orphan.md'),
    })
  })

  it('should serve the prebuilt llms-full.txt', async () => {
    const store = new AssetDocsStore(manifest, mapReader().read)

    await expect(store.getLlmsFull()).resolves.toBe('# Guren — Full Documentation\n')
  })
})

describe('createWorkersAssetReader', () => {
  function binding(status: number, body: string, headers: Record<string, string> = {}) {
    const fetch = vi.fn(async () => new Response(body, { status, headers }))
    return { fetch, reader: createWorkersAssetReader(() => ({ fetch })) }
  }

  it('should fetch the path on a placeholder host and return the body', async () => {
    const { fetch, reader } = binding(200, '{"html":""}')

    await expect(reader('/_docs/en/guides/routing.json')).resolves.toBe('{"html":""}')
    expect(fetch).toHaveBeenCalledWith('https://assets.local/_docs/en/guides/routing.json')
  })

  // `_headers` rules decorate a 404 too, so the status is the only signal.
  it('should treat a 404 as missing even when it carries headers', async () => {
    const { reader } = binding(404, '', { 'cache-control': 'public, max-age=3600' })

    await expect(reader('/_docs/en/guides/missing.json')).resolves.toBeNull()
  })

  it('should throw on any other failure rather than serve it as content', async () => {
    const { reader } = binding(500, 'boom')

    await expect(reader('/_docs/en/guides/routing.json')).rejects.toThrow('answered 500')
  })
})

describe('createPublicFileReader', () => {
  const publicDir = mkdtempSync(resolve(tmpdir(), 'guren-web-public-'))
  mkdirSync(resolve(publicDir, '_docs/en/guides'), { recursive: true })
  writeFileSync(resolve(publicDir, '_docs/en/guides/routing.json'), '{"html":"<p>hi</p>"}')

  afterAll(() => {
    rmSync(publicDir, { recursive: true, force: true })
  })

  it('should read a public path from disk and report absence as null', async () => {
    const read = createPublicFileReader(publicDir)

    await expect(read('/_docs/en/guides/routing.json')).resolves.toBe('{"html":"<p>hi</p>"}')
    await expect(read('/_docs/en/guides/missing.json')).resolves.toBeNull()
  })
})

describe('DocsService with an asset store', () => {
  const service = new DocsService(new AssetDocsStore(manifest, mapReader().read))

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

    expect(guides?.docs.map((doc) => doc.slug)).toEqual(['routing', 'orphan'])
    expect(guides?.sections).toEqual([
      { title: 'The Basics', docs: [{ slug: 'routing', title: 'Routing', description: 'Define routes' }] },
      { title: 'Other', docs: [{ slug: 'orphan', title: 'Orphan' }] },
    ])
  })

  it('should hand back the prebuilt llms-full.txt rather than rebuilding it', async () => {
    await expect(service.getLlmsFull()).resolves.toBe('# Guren — Full Documentation\n')
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
