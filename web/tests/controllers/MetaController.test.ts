import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createControllerContext,
  createControllerModuleMock,
} from '../../../packages/testing/src/controller.js'
import type { Context } from '@guren/core'
import type { DocCategoryGroup } from '../../app/Services/DocsService.js'

vi.mock('@guren/core', () => createControllerModuleMock())

// Mocked at the boundary this controller actually depends on. Loading the real
// blog module here would drag its providers, routes and controllers into a
// docs-endpoint unit test for the sake of one query function.
vi.mock('../../modules/blog/index.js', () => ({
  listPublishedPosts: vi.fn(),
}))

import MetaController, { resetMetaBodyCache } from '../../app/Http/Controllers/MetaController.js'
import { docsService } from '../../app/Services/DocsService.js'
import { listPublishedPosts } from '../../modules/blog/index.js'

const routingDoc = { slug: 'routing', title: 'Routing', description: 'Define routes' }
const categories: DocCategoryGroup[] = [
  {
    category: 'guides',
    title: 'Guides',
    docs: [routingDoc],
    sections: [{ title: 'The Basics', docs: [routingDoc] }],
  },
]

function createController(url: string): MetaController {
  const controller = new MetaController()
  controller.setContext(createControllerContext(url) as unknown as Context)
  return controller
}

const post = {
  slug: 'starting-a-blog',
  title: 'Starting a blog',
  description: 'Why the Guren blog is built with Guren.',
  publishedAt: new Date('2026-07-26T09:05:00Z'),
}

describe('MetaController', () => {
  beforeEach(() => {
    vi.mocked(listPublishedPosts).mockReset().mockResolvedValue([])
  })

  afterEach(() => {
    vi.restoreAllMocks()
    resetMetaBodyCache()
  })

  it('serves a sitemap with hreflang alternates for docs pages', async () => {
    vi.spyOn(docsService, 'listDocs').mockResolvedValue(categories)

    const response = await createController('http://guren.dev/sitemap.xml').sitemap()
    const body = await response.text()

    expect(response.headers.get('Content-Type')).toContain('application/xml')
    expect(body).toContain('<loc>https://guren.dev/docs/guides/routing</loc>')
    expect(body).toContain('<loc>https://guren.dev/docs/ja/guides/routing</loc>')
    expect(body).toContain('hreflang="ja" href="https://guren.dev/docs/ja/guides/routing"')
    expect(body).toContain('hreflang="x-default"')
  })

  it('serves llms.txt with markdown links per doc', async () => {
    vi.spyOn(docsService, 'listDocs').mockResolvedValue(categories)

    const response = await createController('http://guren.dev/llms.txt').llms()
    const body = await response.text()

    expect(response.headers.get('Content-Type')).toContain('text/plain')
    expect(body).toContain('# Guren')
    expect(body).toContain('## Guides')
    expect(body).toContain('- [Routing](https://guren.dev/docs/guides/routing.md): Define routes')
    expect(body).toContain('/llms-full.txt')
  })

  it('serves llms-full.txt with concatenated markdown', async () => {
    vi.spyOn(docsService, 'listDocs').mockResolvedValue(categories)
    vi.spyOn(docsService, 'getRawMarkdown').mockResolvedValue('# Routing\n\nDefine routes.')

    const response = await createController('http://guren.dev/llms-full.txt').llmsFull()
    const body = await response.text()

    expect(docsService.getRawMarkdown).toHaveBeenCalledWith('guides', 'routing', 'en')
    expect(body).toContain('# Guren — Full Documentation')
    expect(body).toContain('<!-- https://guren.dev/docs/guides/routing -->')
    expect(body).toContain('# Routing')
  })

  it('lists the blog index and published posts in the sitemap', async () => {
    vi.spyOn(docsService, 'listDocs').mockResolvedValue(categories)
    vi.mocked(listPublishedPosts).mockResolvedValue([post])

    const response = await createController('http://guren.dev/sitemap.xml').sitemap()
    const body = await response.text()

    expect(body).toContain('<loc>https://guren.dev/blog</loc>')
    expect(body).toContain('<loc>https://guren.dev/blog/starting-a-blog</loc>')
  })

  it('lists published posts and the feed in llms.txt', async () => {
    vi.spyOn(docsService, 'listDocs').mockResolvedValue(categories)
    vi.mocked(listPublishedPosts).mockResolvedValue([post])

    const response = await createController('http://guren.dev/llms.txt').llms()
    const body = await response.text()

    expect(body).toContain('## Blog')
    expect(body).toContain(
      '- [Starting a blog](https://guren.dev/blog/starting-a-blog): Why the Guren blog is built with Guren.',
    )
    expect(body).toContain('https://guren.dev/blog/rss.xml')
  })

  // llms.txt is a machine-parsed list, so a title carrying a newline or a
  // bracket must not split one entry into several or break the link.
  it('flattens author-written text in llms.txt entries', async () => {
    vi.spyOn(docsService, 'listDocs').mockResolvedValue(categories)
    vi.mocked(listPublishedPosts).mockResolvedValue([
      { ...post, title: 'Multi\nline [bracketed]', description: 'a\n\nb' },
    ])

    const response = await createController('http://guren.dev/llms.txt').llms()
    const body = await response.text()

    expect(body).toContain(
      '- [Multi line \\[bracketed\\]](https://guren.dev/blog/starting-a-blog): a b',
    )
  })

  it('omits the blog section from llms.txt when nothing is published', async () => {
    vi.spyOn(docsService, 'listDocs').mockResolvedValue(categories)

    const response = await createController('http://guren.dev/llms.txt').llms()
    const body = await response.text()

    expect(body).not.toContain('## Blog')
  })

  // The docs half is memoized per process; posts are rows the admin UI mutates,
  // so a post published after the first request has to still show up.
  it('re-reads posts on every request instead of serving a memoized list', async () => {
    vi.spyOn(docsService, 'listDocs').mockResolvedValue(categories)
    const listPosts = vi.mocked(listPublishedPosts).mockResolvedValue([])

    const first = await (await createController('http://guren.dev/sitemap.xml').sitemap()).text()
    expect(first).not.toContain('/blog/starting-a-blog')

    listPosts.mockResolvedValue([post])
    const second = await (await createController('http://guren.dev/sitemap.xml').sitemap()).text()

    expect(second).toContain('<loc>https://guren.dev/blog/starting-a-blog</loc>')
  })
})
