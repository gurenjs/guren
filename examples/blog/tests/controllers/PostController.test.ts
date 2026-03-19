import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  createControllerContext,
  createControllerModuleMock,
  readInertiaResponse,
} from '@guren/testing'
import type { Context } from '@guren/server'

const {
  mockWithPaginate,
  mockWith,
  mockFind,
  mockCreate,
  mockUpdate,
  mockGetPaginatedPosts,
  mockGetPost,
  mockInvalidatePost,
  mockEmit,
} = vi.hoisted(() => ({
  mockWithPaginate: vi.fn(),
  mockWith: vi.fn(),
  mockFind: vi.fn(),
  mockCreate: vi.fn(),
  mockUpdate: vi.fn(),
  mockGetPaginatedPosts: vi.fn(),
  mockGetPost: vi.fn(),
  mockInvalidatePost: vi.fn(),
  mockEmit: vi.fn(),
}))

vi.mock('../../app/Models/Post.js', () => ({
  Post: {
    withPaginate: mockWithPaginate,
    with: mockWith,
    find: mockFind,
    create: mockCreate,
    update: mockUpdate,
  },
}))

vi.mock('../../app/Services/PostCacheService.js', () => ({
  getPostCacheService: vi.fn(() => ({
    getPaginatedPosts: mockGetPaginatedPosts,
    getPost: mockGetPost,
    invalidatePost: mockInvalidatePost,
  })),
}))

vi.mock('../../app/Providers/EventServiceProvider.js', () => ({
  getEventManager: vi.fn(() => ({
    emit: mockEmit,
  })),
}))

vi.mock('guren', () => createControllerModuleMock())
vi.mock('@guren/core', () => createControllerModuleMock())
vi.mock('@guren/server', () => createControllerModuleMock())

import PostController from '../../app/Http/Controllers/PostController.js'

type MockAuth = {
  user: ReturnType<typeof vi.fn>
  session: ReturnType<typeof vi.fn>
}

function createAuthStub(user: unknown = null): MockAuth {
  return {
    user: vi.fn().mockResolvedValue(user),
    session: vi.fn().mockReturnValue({
      regenerate: vi.fn(),
      invalidate: vi.fn(),
    }),
  }
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
      mockGetPaginatedPosts.mockResolvedValue({ posts: [samplePost], meta: paginatedPostsResponse.meta })
      const auth = createAuthStub()
      const ctx = createControllerContext('http://blog.test/posts', {
        headers: { 'X-Inertia': 'true' },
      }) as unknown as Context

      const controller = createControllerWithAuth(PostController, auth, ctx)
      const response = await controller.index()
      const { format, payload } = await readInertiaResponse(response)

      expect(format).toBe('json')
      expect(payload.component).toBe('posts/Index')
      expect(payload.props.posts).toEqual([samplePost])
      const pagination = (payload.props as { pagination?: { total: number } }).pagination
      expect(pagination).toBeDefined()
      expect(pagination?.total).toBe(1)
    })

    it('returns page 1 when no page param provided', async () => {
      mockGetPaginatedPosts.mockResolvedValue({ posts: [samplePost], meta: paginatedPostsResponse.meta })
      const auth = createAuthStub()
      const ctx = createControllerContext('http://blog.test/posts', {
        headers: { 'X-Inertia': 'true' },
      }) as unknown as Context

      const controller = createControllerWithAuth(PostController, auth, ctx)
      await controller.index()

      expect(mockGetPaginatedPosts).toHaveBeenCalledWith(1, 6)
    })

    it('passes page parameter to cache service', async () => {
      mockGetPaginatedPosts.mockResolvedValue({ posts: [samplePost], meta: paginatedPostsResponse.meta })
      const auth = createAuthStub()
      const ctx = createControllerContext('http://blog.test/posts?page=2', {
        headers: { 'X-Inertia': 'true' },
      }) as unknown as Context

      const controller = createControllerWithAuth(PostController, auth, ctx)
      await controller.index()

      expect(mockGetPaginatedPosts).toHaveBeenCalledWith(2, 6)
    })

    it('returns HTML for full page visits', async () => {
      mockGetPaginatedPosts.mockResolvedValue({ posts: [samplePost], meta: paginatedPostsResponse.meta })
      const auth = createAuthStub()
      const ctx = createControllerContext('http://blog.test/posts') as unknown as Context

      const controller = createControllerWithAuth(PostController, auth, ctx)
      const response = await controller.index()
      const { format, payload } = await readInertiaResponse(response)

      expect(format).toBe('html')
      expect(payload.component).toBe('posts/Index')
    })
  })

  describe('show()', () => {
    it('returns post with author relation', async () => {
      mockGetPost.mockResolvedValue(samplePost)
      const auth = createAuthStub()
      const ctx = createControllerContext('http://blog.test/posts/1', {
        headers: { 'X-Inertia': 'true' },
      }) as unknown as Context
      // Mock param function
      ;(ctx.req as { param: (key: string) => string }).param = vi.fn().mockReturnValue('1')

      const controller = createControllerWithAuth(PostController, auth, ctx)
      const response = await controller.show()
      const { payload } = await readInertiaResponse(response)

      expect(payload.component).toBe('posts/Show')
      expect(payload.props.post).toEqual(samplePost)
    })

    it('returns 404 for non-existent post', async () => {
      mockGetPost.mockResolvedValue(null)
      const auth = createAuthStub()
      const ctx = createControllerContext('http://blog.test/posts/999', {
        headers: { 'X-Inertia': 'true' },
      }) as unknown as Context
      ;(ctx.req as { param: (key: string) => string }).param = vi.fn().mockReturnValue('999')

      const controller = createControllerWithAuth(PostController, auth, ctx)
      const response = await controller.show()

      expect(response.status).toBe(404)
      const json = await response.json()
      expect(json.message).toBe('Post not found')
    })

    it('returns 400 for invalid post id', async () => {
      const auth = createAuthStub()
      const ctx = createControllerContext('http://blog.test/posts/abc', {
        headers: { 'X-Inertia': 'true' },
      }) as unknown as Context
      ;(ctx.req as { param: (key: string) => string }).param = vi.fn().mockReturnValue('abc')

      const controller = createControllerWithAuth(PostController, auth, ctx)
      const response = await controller.show()

      expect(response.status).toBe(400)
      const json = await response.json()
      expect(json.message).toBe('Invalid post id.')
    })
  })

  describe('create()', () => {
    it('returns create form with Inertia response', async () => {
      const auth = createAuthStub()
      const ctx = createControllerContext('http://blog.test/posts/new', {
        headers: { 'X-Inertia': 'true' },
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
      }) as unknown as Context

      const controller = createControllerWithAuth(PostController, auth, ctx)
      const response = await controller.store()
      const { payload } = await readInertiaResponse(response)

      expect(response.status).toBe(401)
      const errors = (payload.props as { errors?: { message?: string } }).errors
      expect(errors).toBeDefined()
      expect(errors?.message).toBe('You must be signed in to create posts.')
    })

    it('returns validation errors for invalid data', async () => {
      const mockUser = { id: 1, name: 'John Doe' }
      const auth = createAuthStub(mockUser)
      const ctx = createControllerContext('http://blog.test/posts', {
        method: 'POST',
        body: JSON.stringify({ title: '', excerpt: '', body: '' }),
        headers: { 'Content-Type': 'application/json', 'X-Inertia': 'true' },
      }) as unknown as Context

      const controller = createControllerWithAuth(PostController, auth, ctx)
      const response = await controller.store()
      const { payload } = await readInertiaResponse(response)

      expect(response.status).toBe(422)
      expect(payload.component).toBe('posts/New')
      const errors = (payload.props as { errors?: Record<string, unknown> }).errors
      expect(errors).toBeDefined()
    })
  })

  describe('edit()', () => {
    it('returns edit form with post data', async () => {
      mockFind.mockResolvedValue(samplePost)
      const auth = createAuthStub()
      const ctx = createControllerContext('http://blog.test/posts/1/edit', {
        headers: { 'X-Inertia': 'true' },
      }) as unknown as Context
      ;(ctx.req as { param: (key: string) => string }).param = vi.fn().mockReturnValue('1')

      const controller = createControllerWithAuth(PostController, auth, ctx)
      const response = await controller.edit()
      const { payload } = await readInertiaResponse(response)

      expect(response.status).toBe(200)
      expect(payload.component).toBe('posts/Edit')
      expect(payload.props.post).toBeDefined()
      expect(payload.props.postId).toBe(1)
    })

    it('returns 404 for non-existent post', async () => {
      mockFind.mockResolvedValue(null)
      const auth = createAuthStub()
      const ctx = createControllerContext('http://blog.test/posts/999/edit', {
        headers: { 'X-Inertia': 'true' },
      }) as unknown as Context
      ;(ctx.req as { param: (key: string) => string }).param = vi.fn().mockReturnValue('999')

      const controller = createControllerWithAuth(PostController, auth, ctx)
      const response = await controller.edit()
      const { payload } = await readInertiaResponse(response)

      expect(response.status).toBe(404)
      const errors = (payload.props as { errors?: { message?: string } }).errors
      expect(errors?.message).toBe('Post not found.')
    })
  })

  describe('update()', () => {
    it('updates post and redirects', async () => {
      mockFind.mockResolvedValue(samplePost)
      mockUpdate.mockResolvedValue(samplePost)
      const auth = createAuthStub()
      const ctx = createControllerContext('http://blog.test/posts/1', {
        method: 'PUT',
        body: JSON.stringify({ title: 'Updated Title', excerpt: 'Updated excerpt', body: 'Updated body' }),
        headers: { 'Content-Type': 'application/json' },
      }) as unknown as Context
      ;(ctx.req as { param: (key: string) => string }).param = vi.fn().mockReturnValue('1')

      const controller = createControllerWithAuth(PostController, auth, ctx)
      const response = await controller.update()

      expect(response.status).toBe(303)
      expect(response.headers.get('Location')).toBe('/posts/1')
    })

    it('returns 404 for non-existent post', async () => {
      mockFind.mockResolvedValue(null)
      const auth = createAuthStub()
      const ctx = createControllerContext('http://blog.test/posts/999', {
        method: 'PUT',
        body: JSON.stringify({ title: 'Updated', excerpt: 'Excerpt', body: 'Body' }),
        headers: { 'Content-Type': 'application/json' },
      }) as unknown as Context
      ;(ctx.req as { param: (key: string) => string }).param = vi.fn().mockReturnValue('999')

      const controller = createControllerWithAuth(PostController, auth, ctx)
      const response = await controller.update()

      expect(response.status).toBe(404)
    })

    it('returns validation errors for invalid data', async () => {
      mockFind.mockResolvedValue(samplePost)
      const auth = createAuthStub()
      const ctx = createControllerContext('http://blog.test/posts/1', {
        method: 'PUT',
        body: JSON.stringify({ title: '', excerpt: '', body: '' }),
        headers: { 'Content-Type': 'application/json', 'X-Inertia': 'true' },
      }) as unknown as Context
      ;(ctx.req as { param: (key: string) => string }).param = vi.fn().mockReturnValue('1')

      const controller = createControllerWithAuth(PostController, auth, ctx)
      const response = await controller.update()
      const { payload } = await readInertiaResponse(response)

      expect(response.status).toBe(422)
      expect(payload.component).toBe('posts/Edit')
      const errors = (payload.props as { errors?: Record<string, unknown> }).errors
      expect(errors).toBeDefined()
    })
  })
})
