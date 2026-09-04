import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createControllerContext,
  createControllerModuleMock,
  type ControllerContext,
} from '@guren/testing'
import type { Context } from '@guren/core'

vi.mock('@guren/core', () => createControllerModuleMock())

import PostsController from './PostsController.js'
import { Post, type PostRecord } from '../../../Models/Post.js'

function makePost(overrides: Partial<PostRecord> = {}): PostRecord {
  return {
    id: 1,
    slug: 'hello-world',
    title: 'Hello World',
    description: null,
    bodyMarkdown: '# Hello',
    bodyHtml: '<h1>Hello</h1>',
    publishedAt: null,
    createdAt: new Date('2026-06-30T00:00:00Z'),
    updatedAt: new Date('2026-06-30T00:00:00Z'),
    ...overrides,
  }
}

function createAdminContext(
  url: string,
  { id, body }: { id?: number; body?: Record<string, unknown> } = {},
): Context {
  const init: RequestInit =
    body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }

  const ctx = createControllerContext(url, init) as ControllerContext
  ctx.req.param = (name?: string) => {
    const params: Record<string, string> = id === undefined ? {} : { id: String(id) }
    return name === undefined ? params : params[name]
  }

  return ctx as unknown as Context
}

function mockSlugProbe(taken: string[]): void {
  vi.spyOn(Post, 'where').mockImplementation(
    (conditions: unknown) =>
      ({
        first: async () => {
          const slug = (conditions as { slug?: string }).slug
          return slug !== undefined && taken.includes(slug) ? makePost({ slug }) : null
        },
        delete: async () => 1,
      }) as never,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('PostsController', () => {
  describe('store', () => {
    it('should create the post with a slugified title and rendered HTML', async () => {
      mockSlugProbe([])
      const create = vi.spyOn(Post, 'create').mockResolvedValue(makePost())

      const controller = new PostsController()
      controller.setContext(
        createAdminContext('http://guren.dev/admin/posts', {
          body: { title: 'My First Post', bodyMarkdown: '# Hi **there**' },
        }),
      )
      await controller.store()

      expect(create).toHaveBeenCalledTimes(1)
      const record = create.mock.calls[0]![0] as Record<string, unknown>
      expect(record.slug).toBe('my-first-post')
      expect(record.bodyHtml).toContain('<strong>there</strong>')
    })

    it('should retry with a fresh slug when a concurrent create wins the unique race', async () => {
      // First probe sees the slug free, the insert loses the race, and the
      // retry must re-probe and use "-2".
      let probeSeesWinner = false
      vi.spyOn(Post, 'where').mockImplementation(
        (conditions: unknown) =>
          ({
            first: async () => {
              const slug = (conditions as { slug?: string }).slug
              return probeSeesWinner && slug === 'my-post' ? makePost({ slug }) : null
            },
          }) as never,
      )
      const create = vi
        .spyOn(Post, 'create')
        .mockImplementationOnce(async () => {
          probeSeesWinner = true
          throw new Error('UNIQUE constraint failed: posts.slug')
        })
        .mockResolvedValueOnce(makePost())

      const controller = new PostsController()
      controller.setContext(
        createAdminContext('http://guren.dev/admin/posts', {
          body: { title: 'My Post', bodyMarkdown: 'x' },
        }),
      )
      await controller.store()

      expect(create).toHaveBeenCalledTimes(2)
      expect((create.mock.calls[1]![0] as Record<string, unknown>).slug).toBe('my-post-2')
    })
  })

  describe('update', () => {
    it('should never touch the slug so published URLs stay stable', async () => {
      vi.spyOn(Post, 'findOrFail').mockResolvedValue(makePost())
      const update = vi.spyOn(Post, 'update').mockResolvedValue(undefined as never)

      const controller = new PostsController()
      controller.setContext(
        createAdminContext('http://guren.dev/admin/posts/1', {
          id: 1,
          body: { title: 'Renamed Entirely', bodyMarkdown: 'new body' },
        }),
      )
      await controller.update()

      expect(update).toHaveBeenCalledTimes(1)
      const changes = update.mock.calls[0]![1] as Record<string, unknown>
      expect('slug' in changes).toBe(false)
      expect(changes.title).toBe('Renamed Entirely')
    })
  })

  describe('setPublished', () => {
    it('should publish a draft with a fresh timestamp', async () => {
      vi.spyOn(Post, 'findOrFail').mockResolvedValue(makePost({ publishedAt: null }))
      const update = vi.spyOn(Post, 'update').mockResolvedValue(undefined as never)

      const controller = new PostsController()
      controller.setContext(
        createAdminContext('http://guren.dev/admin/posts/1/publish', {
          id: 1,
          body: { published: true },
        }),
      )
      await controller.setPublished()

      const changes = update.mock.calls[0]![1] as Record<string, unknown>
      expect(changes.publishedAt).toBeInstanceOf(Date)
    })

    it('should be idempotent: re-publishing keeps the original publishedAt', async () => {
      const original = new Date('2026-07-01T00:00:00Z')
      vi.spyOn(Post, 'findOrFail').mockResolvedValue(makePost({ publishedAt: original }))
      const update = vi.spyOn(Post, 'update').mockResolvedValue(undefined as never)

      const controller = new PostsController()
      controller.setContext(
        createAdminContext('http://guren.dev/admin/posts/1/publish', {
          id: 1,
          body: { published: true },
        }),
      )
      await controller.setPublished()

      expect((update.mock.calls[0]![1] as Record<string, unknown>).publishedAt).toBe(original)
    })

    it('should unpublish when the client states published: false', async () => {
      vi.spyOn(Post, 'findOrFail').mockResolvedValue(
        makePost({ publishedAt: new Date('2026-07-01T00:00:00Z') }),
      )
      const update = vi.spyOn(Post, 'update').mockResolvedValue(undefined as never)

      const controller = new PostsController()
      controller.setContext(
        createAdminContext('http://guren.dev/admin/posts/1/publish', {
          id: 1,
          body: { published: false },
        }),
      )
      await controller.setPublished()

      expect((update.mock.calls[0]![1] as Record<string, unknown>).publishedAt).toBeNull()
    })
  })
})
