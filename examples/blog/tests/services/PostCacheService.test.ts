import type { CacheManager } from '@guren/core'
import { describe, expect, it, vi } from 'vitest'

const { store, rememberMock, deleteMock, clearMock } = vi.hoisted(() => {
  const rememberMock = vi.fn(async (_key: string, _ttl: number, callback: () => Promise<unknown>) => callback())
  const deleteMock = vi.fn(async () => {})
  const clearMock = vi.fn(async () => {})

  const store = {
    remember: rememberMock,
    delete: deleteMock,
    clear: clearMock,
  }

  return { store, rememberMock, deleteMock, clearMock }
})

const { withPaginateMock, withMock } = vi.hoisted(() => ({
  withPaginateMock: vi.fn(),
  withMock: vi.fn(),
}))

vi.mock('../../app/Models/Post.js', () => ({
  Post: {
    withPaginate: withPaginateMock,
    with: withMock,
  },
}))

import { PostCacheService } from '../../app/Services/PostCacheService.js'

const cacheManager = {
  store: () => store,
} as unknown as CacheManager

describe('PostCacheService', () => {
  it('caches paginated posts', async () => {
    const service = new PostCacheService(cacheManager)
    withPaginateMock.mockResolvedValue({
      data: [{ id: 1, title: 'Post' }],
      meta: { total: 1 },
    })

    const result = await service.getPaginatedPosts(1, 6)

    expect(rememberMock).toHaveBeenCalledWith(
      'posts:page:1:per:6',
      60,
      expect.any(Function),
    )
    expect(result.data).toHaveLength(1)
  })

  it('normalizes pagination inputs before querying and caching', async () => {
    const service = new PostCacheService(cacheManager)
    withPaginateMock.mockResolvedValue({
      data: [{ id: 1, title: 'Post' }],
      meta: { total: 1, perPage: 6, currentPage: 1 },
    })

    await service.getPaginatedPosts(0, 0)

    expect(rememberMock).toHaveBeenCalledWith(
      'posts:page:1:per:6',
      60,
      expect.any(Function),
    )
    expect(withPaginateMock).toHaveBeenCalledWith('author', {
      page: 1,
      perPage: 6,
      orderBy: ['id', 'desc'],
    })
  })

  it('fetches a single post with caching', async () => {
    const service = new PostCacheService(cacheManager)
    withMock.mockResolvedValue([{ id: 2, title: 'Hello' }])

    const post = await service.getPost(2)

    expect(rememberMock).toHaveBeenCalledWith(
      'posts:2',
      300,
      expect.any(Function),
    )
    expect(post).toMatchObject({ id: 2 })
  })

  it('invalidates cached entries', async () => {
    const service = new PostCacheService(cacheManager)

    await service.invalidatePost(3)

    expect(deleteMock).toHaveBeenCalledWith('posts:3')
    expect(deleteMock).toHaveBeenCalledWith('posts:page:1:per:6')
  })

  it('clears the cache store', async () => {
    const service = new PostCacheService(cacheManager)
    await service.clearAll()
    expect(clearMock).toHaveBeenCalled()
  })
})
