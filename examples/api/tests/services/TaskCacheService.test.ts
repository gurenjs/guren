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

describe('TaskCacheService', () => {
  it('caches task pages per user', async () => {
    const service = new TaskCacheService()
    paginateMock.mockResolvedValue({
      data: [{ id: 1 }],
      meta: { total: 1 },
    })

    const result = await service.getUserTasks(2, 1, 15)

    expect(rememberMock).toHaveBeenCalledWith(
      'tasks:user:2:page:1:per:15',
      60,
      expect.any(Function),
    )
    expect(result.tasks).toHaveLength(1)
  })

  it('invalidates cached task entries', async () => {
    const service = new TaskCacheService()

    await service.invalidateTask(5, 2)

    expect(deleteMock).toHaveBeenCalledWith('tasks:5')
    expect(deleteMock).toHaveBeenCalledWith('tasks:user:2:page:1:per:15')
  })

  it('clears all caches', async () => {
    const service = new TaskCacheService()
    await service.clearAll()
    expect(clearMock).toHaveBeenCalled()
  })
})
