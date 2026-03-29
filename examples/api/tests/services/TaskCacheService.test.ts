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

const { paginateMock, findMock } = vi.hoisted(() => ({
  paginateMock: vi.fn(),
  findMock: vi.fn(),
}))

vi.mock('../../app/Models/Task.js', () => ({
  Task: {
    paginate: paginateMock,
    find: findMock,
  },
}))

import { TaskCacheService } from '../../app/Services/TaskCacheService.js'

const cacheManager = {
  store: () => store,
} as unknown as CacheManager

describe('TaskCacheService', () => {
  it('caches task pages per user', async () => {
    const service = new TaskCacheService(cacheManager)
    paginateMock.mockResolvedValue({
      data: [{ id: 1 }],
      meta: { total: 1 },
    })

    const result = await service.getUserTasks(2, 1, 15)

    expect(rememberMock).toHaveBeenCalledWith(
      'tasks:user:2:page:1:per:15:completed:all',
      60,
      expect.any(Function),
    )
    expect(result.data).toHaveLength(1)
  })

  it('normalizes pagination inputs before querying and caching', async () => {
    const service = new TaskCacheService(cacheManager)
    paginateMock.mockResolvedValue({
      data: [{ id: 1 }],
      meta: { total: 1, perPage: 15, currentPage: 1 },
    })

    await service.getUserTasks(2, 0, 0)

    expect(rememberMock).toHaveBeenCalledWith(
      'tasks:user:2:page:1:per:15:completed:all',
      60,
      expect.any(Function),
    )
    expect(paginateMock).toHaveBeenCalledWith({
      where: { userId: 2 },
      page: 1,
      perPage: 15,
      orderBy: ['id', 'desc'],
    })
  })

  it('invalidates cached task entries', async () => {
    const service = new TaskCacheService(cacheManager)

    await service.invalidateTask(5, 2)

    expect(deleteMock).toHaveBeenCalledWith('tasks:5')
    expect(deleteMock).toHaveBeenCalledWith('tasks:user:2:page:1:per:15:completed:all')
    expect(deleteMock).toHaveBeenCalledWith('tasks:user:2:page:1:per:15:completed:true')
    expect(deleteMock).toHaveBeenCalledWith('tasks:user:2:page:1:per:15:completed:false')
  })

  it('clears all caches', async () => {
    const service = new TaskCacheService(cacheManager)
    await service.clearAll()
    expect(clearMock).toHaveBeenCalled()
  })
})
