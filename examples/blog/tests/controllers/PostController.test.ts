import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  createControllerContext,
  createControllerModuleMock,
  readInertiaResponse,
} from '@guren/testing'
import type { Context } from '@guren/core'

const {
  mockFindOrFail,
  mockFindWithOrFail,
  mockCreate,
  mockUpdate,
  mockGetPaginatedPosts,
  mockInvalidatePost,
  mockEmit,
  MockPostCacheService,
} = vi.hoisted(() => ({
  mockFindOrFail: vi.fn(),
  mockFindWithOrFail: vi.fn(),
  mockCreate: vi.fn(),
  mockUpdate: vi.fn(),
  mockGetPaginatedPosts: vi.fn(),
  mockInvalidatePost: vi.fn(),
  mockEmit: vi.fn(),
  MockPostCacheService: vi.fn().mockImplementation(() => ({
    getPaginatedPosts: mockGetPaginatedPosts,
    invalidatePost: mockInvalidatePost,
  })),
}))

vi.mock('../../app/Models/Post.js', () => ({
  Post: {
    findOrFail: mockFindOrFail,
    findWithOrFail: mockFindWithOrFail,
    create: mockCreate,
    update: mockUpdate,
  },
}))

vi.mock('../../app/Services/PostCacheService.js', () => ({
  POSTS_PAGE_SIZE: 6,
  PostCacheService: MockPostCacheService,
}))

vi.mock('guren', () => createControllerModuleMock())
vi.mock('@guren/core', async () => {
  const actual = await vi.importActual<typeof import('@guren/core')>('@guren/core')
  return {
    ...actual,
    ...createControllerModuleMock(),
    ServiceProvider: actual.ServiceProvider,
    collect: vi.fn((resources: unknown[]) => resources),
    paginate: vi.fn((result: { meta: { total: number; perPage: number; currentPage: number } }, options?: { path?: string }) => {
      const lastPage = Math.max(1, Math.ceil(result.meta.total / result.meta.perPage))
      const path = options?.path ?? ''
      const buildPageUrl = (page: number) => `${path}?page=${page}`

      return {
        meta: () => ({
          currentPage: result.meta.currentPage,
          lastPage,
          perPage: result.meta.perPage,
          total: result.meta.total,
          from: result.meta.total === 0 ? null : (result.meta.currentPage - 1) * result.meta.perPage + 1,
          to: result.meta.total === 0 ? null : Math.min(result.meta.total, result.meta.currentPage * result.meta.perPage),
        }),
        links: () => ({
          first: buildPageUrl(1),
          last: buildPageUrl(lastPage),
          prev: result.meta.currentPage > 1 ? buildPageUrl(result.meta.currentPage - 1) : null,
          next: result.meta.currentPage < lastPage ? buildPageUrl(result.meta.currentPage + 1) : null,
          pages: Array.from({ length: lastPage }, (_, index) => {
            const page = index + 1
            return {
              page,
              url: buildPageUrl(page),
              active: page === result.meta.currentPage,
            }
          }),
        }),
      }
    }),
  }
})

import PostController from '../../app/Http/Controllers/PostController.js'

type MockAuth = {
  user: ReturnType<typeof vi.fn>
  userOrFail: ReturnType<typeof vi.fn>
  session: ReturnType<typeof vi.fn>
}

function createAuthStub(user: unknown = null): MockAuth {
  return {
    user: vi.fn().mockResolvedValue(user),
    userOrFail: user
      ? vi.fn().mockResolvedValue(user)
      : vi.fn().mockRejectedValue(Object.assign(new Error('Unauthenticated.'), { statusCode: 401 })),
    session: vi.fn().mockReturnValue({
      regenerate: vi.fn(),
      invalidate: vi.fn(),
    }),
  }
}

function setRouteParams(ctx: Context, params: Record<string, string>): void {
  ;(ctx.req as { param: (key?: string) => string | Record<string, string> | undefined }).param = vi.fn((key?: string) =>
    key ? params[key] : params,
  )
}

function createControllerWithAuth<T extends { setContext: (ctx: Context) => void }>(
  ControllerClass: new () => T,
  auth: MockAuth,
  ctx: Context,
): T {
  const controller = new ControllerClass()
  Object.defineProperty(controller, 'auth', {
    value: auth,
    configurable: true,
  })
  controller.setContext(ctx)
  return controller
}

// Sample post data
const samplePost = {
  id: 1,
  title: 'Test Post',
  excerpt: 'Test excerpt',
  body: 'Test body content',
  authorId: 1,
  author: { id: 1, name: 'John Doe' },
}

const paginatedPostsResponse = {
  data: [samplePost],
  meta: {
    total: 1,
    perPage: 6,
    currentPage: 1,
    totalPages: 1,
    hasMore: false,
    from: 1,
    to: 1,
  },
}

describe('PostController', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('index()', () => {
    it('returns paginated posts with Inertia response', async () => {
      mockGetPaginatedPosts.mockResolvedValue(paginatedPostsResponse)
      const auth = createAuthStub()
      const ctx = createControllerContext('http://blog.test/posts', {
        headers: { 'X-Inertia': 'true' },
      }, {
        cache: { store: vi.fn() },
        events: { emit: mockEmit },
      }) as unknown as Context

      const controller = createControllerWithAuth(PostController, auth, ctx)
      const response = await controller.index()
      const { format, payload } = await readInertiaResponse(response)

      expect(format).toBe('json')
      expect(payload.component).toBe('posts/Index')
      expect(payload.props.data).toEqual([{
        id: samplePost.id,
        title: samplePost.title,
        excerpt: samplePost.excerpt,
        body: samplePost.body,
        notificationArtifactPath: `notifications/posts/${samplePost.id}.json`,
        broadcastChannels: {
          public: 'announcements',
          private: `posts.${samplePost.id}`,
        },
        author: samplePost.author,
      }])
      const pagination = (payload.props as {
        pagination?: {
          meta: { total: number; currentPage: number }
          links: { prev: string | null; next: string | null; pages: Array<{ page: number; url: string | null; active: boolean }> }
        }
      }).pagination
      expect(pagination).toBeDefined()
      expect(pagination?.meta.total).toBe(1)
      expect(pagination?.links.pages[0]).toEqual({
        page: 1,
        url: '/posts?page=1',
        active: true,
      })
    })

    it('returns page 1 when no page param provided', async () => {
      mockGetPaginatedPosts.mockResolvedValue(paginatedPostsResponse)
      const auth = createAuthStub()
      const ctx = createControllerContext('http://blog.test/posts', {
        headers: { 'X-Inertia': 'true' },
      }, {
        cache: { store: vi.fn() },
        events: { emit: mockEmit },
      }) as unknown as Context

      const controller = createControllerWithAuth(PostController, auth, ctx)
      await controller.index()

      expect(mockGetPaginatedPosts).toHaveBeenCalledWith(1, 6)
    })

    it('passes page parameter to cache service', async () => {
      mockGetPaginatedPosts.mockResolvedValue(paginatedPostsResponse)
      const auth = createAuthStub()
      const ctx = createControllerContext('http://blog.test/posts?page=2', {
        headers: { 'X-Inertia': 'true' },
      }, {
        cache: { store: vi.fn() },
        events: { emit: mockEmit },
      }) as unknown as Context

      const controller = createControllerWithAuth(PostController, auth, ctx)
      await controller.index()

      expect(mockGetPaginatedPosts).toHaveBeenCalledWith(2, 6)
    })

    it('returns HTML for full page visits', async () => {
      mockGetPaginatedPosts.mockResolvedValue(paginatedPostsResponse)
      const auth = createAuthStub()
      const ctx = createControllerContext('http://blog.test/posts', {}, {
        cache: { store: vi.fn() },
        events: { emit: mockEmit },
      }) as unknown as Context

      const controller = createControllerWithAuth(PostController, auth, ctx)
      const response = await controller.index()
      const { format, payload } = await readInertiaResponse(response)

      expect(format).toBe('html')
      expect(payload.component).toBe('posts/Index')
    })
  })

  describe('show()', () => {
    it('returns post with author relation', async () => {
      mockFindWithOrFail.mockResolvedValue(samplePost)
      const auth = createAuthStub()
      const ctx = createControllerContext('http://blog.test/posts/1', {
        headers: { 'X-Inertia': 'true' },
      }, {
        cache: { store: vi.fn() },
        events: { emit: mockEmit },
      }) as unknown as Context
      setRouteParams(ctx, { id: '1' })

      const controller = createControllerWithAuth(PostController, auth, ctx)
      const response = await controller.show()
      const { payload } = await readInertiaResponse(response)

      expect(payload.component).toBe('posts/Show')
      expect((payload.props as { post: { notificationArtifactPath: string; broadcastChannels: { public: string } } }).post.notificationArtifactPath).toBe('notifications/posts/1.json')
      expect((payload.props as { post: { notificationArtifactPath: string; broadcastChannels: { public: string } } }).post.broadcastChannels.public).toBe('announcements')
      expect(payload.props.post).toEqual({
        id: samplePost.id,
        title: samplePost.title,
        excerpt: samplePost.excerpt,
        body: samplePost.body,
        author: samplePost.author,
        notificationArtifactPath: 'notifications/posts/1.json',
        broadcastChannels: {
          public: 'announcements',
          private: 'posts.1',
        },
      })
    })

    it('returns 404 for non-existent post', async () => {
      mockFindWithOrFail.mockRejectedValue(Object.assign(new Error('Post not found'), { statusCode: 404 }))
      const auth = createAuthStub()
      const ctx = createControllerContext('http://blog.test/posts/999', {
        headers: { 'X-Inertia': 'true' },
      }, {
        cache: { store: vi.fn() },
        events: { emit: mockEmit },
      }) as unknown as Context
      setRouteParams(ctx, { id: '999' })

      const controller = createControllerWithAuth(PostController, auth, ctx)
      await expect(controller.show()).rejects.toMatchObject({ statusCode: 404, message: 'Post not found' })
    })

    it('returns 400 for invalid post id', async () => {
      const auth = createAuthStub()
      const ctx = createControllerContext('http://blog.test/posts/abc', {
        headers: { 'X-Inertia': 'true' },
      }, {
        cache: { store: vi.fn() },
        events: { emit: mockEmit },
      }) as unknown as Context
      setRouteParams(ctx, { id: 'abc' })

      const controller = createControllerWithAuth(PostController, auth, ctx)
      await expect(controller.show()).rejects.toMatchObject({ statusCode: 400 })
    })
  })

  describe('create()', () => {
    it('returns create form with Inertia response', async () => {
      const auth = createAuthStub()
      const ctx = createControllerContext('http://blog.test/posts/new', {
        headers: { 'X-Inertia': 'true' },
      }, {
        cache: { store: vi.fn() },
        events: { emit: mockEmit },
      }) as unknown as Context

      const controller = createControllerWithAuth(PostController, auth, ctx)
      const response = await controller.create()
      const { payload } = await readInertiaResponse(response)

      expect(response.status).toBe(200)
      expect(payload.component).toBe('posts/New')
    })
  })

  describe('store()', () => {
    it('creates post and redirects when authenticated', async () => {
      const mockUser = { id: 1, name: 'John Doe' }
      const createdPost = { id: 42, title: 'New Post', excerpt: 'Excerpt', body: 'Body content', authorId: 1 }
      mockCreate.mockResolvedValue(createdPost)
      const auth = createAuthStub(mockUser)
      const ctx = createControllerContext('http://blog.test/posts', {
        method: 'POST',
        body: JSON.stringify({ title: 'New Post', excerpt: 'Excerpt', body: 'Body content' }),
        headers: { 'Content-Type': 'application/json' },
      }, {
        cache: { store: vi.fn() },
        events: { emit: mockEmit },
      }) as unknown as Context

      const controller = createControllerWithAuth(PostController, auth, ctx)
      const response = await controller.store()

      expect(response.status).toBe(303)
      expect(response.headers.get('Location')).toBe('/posts/42')
      expect(mockCreate).toHaveBeenCalledWith({
        title: 'New Post',
        excerpt: 'Excerpt',
        body: 'Body content',
        authorId: 1,
      })
    })

    it('returns 401 when not authenticated', async () => {
      const auth = createAuthStub(null)
      const ctx = createControllerContext('http://blog.test/posts', {
        method: 'POST',
        body: JSON.stringify({ title: 'New Post', excerpt: 'Excerpt', body: 'Body content' }),
        headers: { 'Content-Type': 'application/json', 'X-Inertia': 'true' },
      }, {
        cache: { store: vi.fn() },
        events: { emit: mockEmit },
      }) as unknown as Context

      const controller = createControllerWithAuth(PostController, auth, ctx)
      await expect(controller.store()).rejects.toMatchObject({ statusCode: 401, message: 'Unauthenticated.' })
    })

    it('returns validation errors for invalid data', async () => {
      const mockUser = { id: 1, name: 'John Doe' }
      const auth = createAuthStub(mockUser)
      const ctx = createControllerContext('http://blog.test/posts', {
        method: 'POST',
        body: JSON.stringify({ title: '', excerpt: '', body: '' }),
        headers: { 'Content-Type': 'application/json', 'X-Inertia': 'true' },
      }, {
        cache: { store: vi.fn() },
        events: { emit: mockEmit },
      }) as unknown as Context

      const controller = createControllerWithAuth(PostController, auth, ctx)
      await expect(controller.store()).rejects.toMatchObject({
        statusCode: 422,
        errors: expect.objectContaining({
          title: expect.any(Array),
          excerpt: expect.any(Array),
          body: expect.any(Array),
        }),
      })
    })
  })

  describe('edit()', () => {
    it('returns edit form with post data', async () => {
      mockFindOrFail.mockResolvedValue(samplePost)
      const auth = createAuthStub()
      const ctx = createControllerContext('http://blog.test/posts/1/edit', {
        headers: { 'X-Inertia': 'true' },
      }, {
        cache: { store: vi.fn() },
        events: { emit: mockEmit },
      }) as unknown as Context
      setRouteParams(ctx, { id: '1' })

      const controller = createControllerWithAuth(PostController, auth, ctx)
      const response = await controller.edit()
      const { payload } = await readInertiaResponse(response)

      expect(response.status).toBe(200)
      expect(payload.component).toBe('posts/Edit')
      expect(payload.props.post).toBeDefined()
      expect(payload.props.postId).toBe(1)
    })

    it('returns 404 for non-existent post', async () => {
      mockFindOrFail.mockRejectedValue(Object.assign(new Error('Post not found'), { statusCode: 404 }))
      const auth = createAuthStub()
      const ctx = createControllerContext('http://blog.test/posts/999/edit', {
        headers: { 'X-Inertia': 'true' },
      }, {
        cache: { store: vi.fn() },
        events: { emit: mockEmit },
      }) as unknown as Context
      setRouteParams(ctx, { id: '999' })

      const controller = createControllerWithAuth(PostController, auth, ctx)
      await expect(controller.edit()).rejects.toMatchObject({ statusCode: 404, message: 'Post not found' })
    })
  })

  describe('update()', () => {
    it('updates post and redirects', async () => {
      mockFindOrFail.mockResolvedValue(samplePost)
      mockUpdate.mockResolvedValue(samplePost)
      const auth = createAuthStub()
      const ctx = createControllerContext('http://blog.test/posts/1', {
        method: 'PUT',
        body: JSON.stringify({ title: 'Updated Title', excerpt: 'Updated excerpt', body: 'Updated body' }),
        headers: { 'Content-Type': 'application/json' },
      }, {
        cache: { store: vi.fn() },
        events: { emit: mockEmit },
      }) as unknown as Context
      setRouteParams(ctx, { id: '1' })

      const controller = createControllerWithAuth(PostController, auth, ctx)
      const response = await controller.update()

      expect(response.status).toBe(303)
      expect(response.headers.get('Location')).toBe('/posts/1')
    })

    it('returns 404 for non-existent post', async () => {
      mockFindOrFail.mockRejectedValue(Object.assign(new Error('Post not found'), { statusCode: 404 }))
      const auth = createAuthStub()
      const ctx = createControllerContext('http://blog.test/posts/999', {
        method: 'PUT',
        body: JSON.stringify({ title: 'Updated', excerpt: 'Excerpt', body: 'Body' }),
        headers: { 'Content-Type': 'application/json' },
      }, {
        cache: { store: vi.fn() },
        events: { emit: mockEmit },
      }) as unknown as Context
      setRouteParams(ctx, { id: '999' })

      const controller = createControllerWithAuth(PostController, auth, ctx)
      await expect(controller.update()).rejects.toMatchObject({ statusCode: 404, message: 'Post not found' })
    })

    it('returns validation errors for invalid data', async () => {
      mockFindOrFail.mockResolvedValue(samplePost)
      const auth = createAuthStub()
      const ctx = createControllerContext('http://blog.test/posts/1', {
        method: 'PUT',
        body: JSON.stringify({ title: '', excerpt: '', body: '' }),
        headers: { 'Content-Type': 'application/json', 'X-Inertia': 'true' },
      }, {
        cache: { store: vi.fn() },
        events: { emit: mockEmit },
      }) as unknown as Context
      setRouteParams(ctx, { id: '1' })

      const controller = createControllerWithAuth(PostController, auth, ctx)
      await expect(controller.update()).rejects.toMatchObject({
        statusCode: 422,
        errors: expect.objectContaining({
          title: expect.any(Array),
          excerpt: expect.any(Array),
          body: expect.any(Array),
        }),
      })
    })
  })
})
