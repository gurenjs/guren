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

vi.mock('@guren/server', () => ({
  createCacheManager: () => ({
    store: () => store,
  }),
}))

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

describe('PostCacheService', () => {
  it('caches paginated posts', async () => {
    const service = new PostCacheService()
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
    expect(result.posts).toHaveLength(1)
  })

  it('fetches a single post with caching', async () => {
    const service = new PostCacheService()
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
    const service = new PostCacheService()

    await service.invalidatePost(3)

    expect(deleteMock).toHaveBeenCalledWith('posts:3')
    expect(deleteMock).toHaveBeenCalledWith('posts:page:1:per:6')
  })

  it('clears the cache store', async () => {
    const service = new PostCacheService()
    await service.clearAll()
    expect(clearMock).toHaveBeenCalled()
  })
})
