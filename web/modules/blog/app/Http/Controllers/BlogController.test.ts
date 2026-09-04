import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createControllerContext,
  createControllerModuleMock,
  readInertiaResponse,
  type ControllerContext,
} from '@guren/testing'
import type { Context } from '@guren/core'

vi.mock('@guren/core', () => createControllerModuleMock())

import BlogController from './BlogController.js'
import { Post, type PostRecord } from '../../Models/Post.js'

function makePost(overrides: Partial<PostRecord> = {}): PostRecord {
  return {
    id: 1,
    slug: 'hello-world',
    title: 'Hello World',
    description: 'First post',
    bodyMarkdown: '# Hello',
    bodyHtml: '<h1>Hello</h1>',
    publishedAt: new Date('2026-07-01T00:00:00Z'),
    createdAt: new Date('2026-06-30T00:00:00Z'),
    updatedAt: new Date('2026-06-30T00:00:00Z'),
    ...overrides,
  }
}

function createBlogContext(
  url: string,
  { slug, authenticated }: { slug?: string; authenticated?: boolean } = {},
): Context {
  const contextValues: Record<string, unknown> = {}
  if (authenticated !== undefined) {
    contextValues['guren:auth'] = { check: async () => authenticated }
  }

  const ctx = createControllerContext(url, {}, contextValues) as ControllerContext
  ctx.req.param = (name?: string) => {
    const params: Record<string, string> = slug === undefined ? {} : { slug }
    return name === undefined ? params : params[name]
  }

  return ctx as unknown as Context
}

function stubFindBySlug(record: PostRecord | null): void {
  vi.spyOn(Post, 'where').mockReturnValue({
    first: async () => record,
  } as unknown as ReturnType<typeof Post.where>)
}

describe('BlogController', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('index', () => {
    it('should query published posts newest-first and drop scheduled ones', async () => {
      const older = makePost({ id: 1, slug: 'older', publishedAt: new Date('2026-06-01T00:00:00Z') })
      const newer = makePost({ id: 2, slug: 'newer', publishedAt: new Date('2026-07-01T00:00:00Z') })
      const scheduled = makePost({ id: 4, slug: 'scheduled', publishedAt: new Date(Date.now() + 86_400_000) })
      // Ordering and the unpublished filter happen in SQL, so the mock returns
      // rows already ordered and the assertions cover the query shape plus the
      // future-dated guard the database cannot express.
      const chain = {
        whereNotNull: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        get: vi.fn().mockResolvedValue([newer, older, scheduled]),
      }
      const select = vi.spyOn(Post, 'select').mockReturnValue(chain as never)

      const controller = new BlogController()
      controller.setContext(createBlogContext('http://guren.dev/blog'))

      const { payload } = await readInertiaResponse(await controller.index())

      expect(select).toHaveBeenCalledWith('slug', 'title', 'description', 'publishedAt')
      expect(chain.whereNotNull).toHaveBeenCalledWith('publishedAt')
      expect(chain.orderBy).toHaveBeenCalledWith('publishedAt', 'desc')
      expect(payload.component).toBe('blog/Index')
      expect((payload.props.posts as Array<{ slug: string }>).map((post) => post.slug)).toEqual([
        'newer',
        'older',
      ])
    })
  })

  // show() renders plain server HTML, so these assert on the document.
  describe('show', () => {
    it('should return a 404 document for an unknown slug', async () => {
      stubFindBySlug(null)

      const controller = new BlogController()
      controller.setContext(createBlogContext('http://guren.dev/blog/missing', { slug: 'missing' }))

      const response = await controller.show()
      const html = await response.text()

      expect(response.status).toBe(404)
      // The <title> also says "Post not found", so assert what only the body has.
      expect(html).toContain('exist or has been unpublished')
      expect(html).toContain('href="/blog"')
      expect(html).toMatch(/<head>[\s\S]*noindex[\s\S]*<\/head>/)
      expect(html).toMatch(/<link rel="stylesheet" href="[^"]*resources\/css\/app\.css"/)
    })

    it('should hide unpublished posts from guests', async () => {
      stubFindBySlug(makePost({ slug: 'draft', publishedAt: null }))

      const controller = new BlogController()
      controller.setContext(createBlogContext('http://guren.dev/blog/draft', { slug: 'draft' }))

      const response = await controller.show()

      expect(response.status).toBe(404)
    })

    it('should show unpublished posts to the authenticated admin', async () => {
      stubFindBySlug(makePost({ slug: 'draft', publishedAt: null }))

      const controller = new BlogController()
      controller.setContext(
        createBlogContext('http://guren.dev/blog/draft', { slug: 'draft', authenticated: true }),
      )

      const response = await controller.show()
      const html = await response.text()

      expect(response.status).toBe(200)
      expect(html).toContain('<h1>Hello</h1>')
    })

    it('should render a published post as a full document without an Inertia payload', async () => {
      stubFindBySlug(makePost())

      const controller = new BlogController()
      controller.setContext(createBlogContext('http://guren.dev/blog/hello-world', { slug: 'hello-world' }))

      const response = await controller.show()
      const html = await response.text()

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
      expect(html.startsWith('<!doctype html><html lang="en">')).toBe(true)
      // Exactly once: the doubled payload (escaped JSON + SSR HTML) was the
      // reason this page left Inertia.
      expect(html.split('<h1>Hello</h1>').length - 1).toBe(1)
      expect(html).not.toContain('__INERTIA_PAGE__')
      expect(html).not.toContain('data-page')
      expect(html).toMatch(/<head>[\s\S]*Hello World[\s\S]*<\/head>/)
      expect(html).toMatch(/<head>[\s\S]*rel="canonical"[\s\S]*<\/head>/)
      expect(html).toMatch(/<link rel="stylesheet" href="[^"]*resources\/css\/app\.css"/)
    })
  })
})
