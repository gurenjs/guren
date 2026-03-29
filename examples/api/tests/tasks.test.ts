import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  createControllerContext,
  createControllerModuleMock,
} from '@guren/testing/controller'
import type { Context } from '@guren/core'
import { paginate } from '@guren/core'

const {
  mockTaskCreate,
  mockTaskFirst,
  mockTaskFind,
  mockTaskUpdate,
  mockTaskDelete,
  mockGetUserTasks,
  mockEmit,
  mockPaginate,
  MockTaskCacheService,
} = vi.hoisted(() => ({
  mockTaskCreate: vi.fn(),
  mockTaskFirst: vi.fn(),
  mockTaskFind: vi.fn(),
  mockTaskUpdate: vi.fn(),
  mockTaskDelete: vi.fn(),
  mockGetUserTasks: vi.fn(),
  mockEmit: vi.fn(),
  mockPaginate: vi.fn().mockReturnValue({
    withPath: vi.fn().mockReturnThis(),
    withQuery: vi.fn().mockReturnThis(),
    toResource: vi.fn().mockReturnValue({
      data: [],
      meta: { currentPage: 1, lastPage: 1, perPage: 15, total: 0 },
      links: {},
    }),
  }),
  MockTaskCacheService: vi.fn().mockImplementation(() => ({
    getUserTasks: mockGetUserTasks,
    invalidateTask: vi.fn(),
    invalidateUserTasks: vi.fn(),
  })),
}))

vi.mock('@guren/core', async () => {
  const actual = await vi.importActual<typeof import('@guren/core')>('@guren/core')
  return {
    ...actual,
    ...createControllerModuleMock(),
    ServiceProvider: actual.ServiceProvider,
    paginate: mockPaginate,
  }
})

vi.mock('../app/Models/Task.js', () => ({
  Task: {
    create: mockTaskCreate,
    first: mockTaskFirst,
    find: mockTaskFind,
    update: mockTaskUpdate,
    delete: mockTaskDelete,
  },
}))

vi.mock('../app/Services/TaskCacheService.js', () => ({
  TaskCacheService: MockTaskCacheService,
}))

import TaskController from '../app/Http/Controllers/TaskController.js'

function createController(ctx: Context): TaskController {
  const controller = new TaskController()
  controller.setContext(ctx)
  return controller
}

function authenticatedContext(url: string, init: RequestInit = {}): Context {
  return createControllerContext(url, init, {
    'guren:api-token': { userId: 1, abilities: ['*'], token: {} },
    cache: { store: vi.fn() },
    events: { emit: mockEmit },
  }) as unknown as Context
}

describe('TaskController', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('index()', () => {
    it('throws when unauthenticated', async () => {
      const ctx = createControllerContext('http://api.test/api/tasks', {
        method: 'GET',
      }) as unknown as Context

      const controller = createController(ctx)

      await expect(controller.index()).rejects.toMatchObject({
        statusCode: 401,
      })
    })

    it('returns paginated tasks when authenticated', async () => {
      mockGetUserTasks.mockResolvedValue({
        data: [{ id: 1, title: 'Task 1', completed: false, createdAt: new Date(), updatedAt: new Date() }],
        meta: { total: 21, perPage: 15, currentPage: 2, totalPages: 2, hasMore: false, from: 16, to: 21 },
      })

      const ctx = authenticatedContext('http://api.test/api/tasks?page=999&per_page=15&completed=true', {
        method: 'GET',
      })

      const controller = createController(ctx)
      const response = await controller.index()

      expect(response.status).toBe(200)
      expect(mockGetUserTasks).toHaveBeenCalledWith(1, 999, 15, { completed: true })
      expect(paginate).toHaveBeenCalledWith(
        {
          data: [{ id: 1, title: 'Task 1', completed: false, createdAt: expect.any(Date), updatedAt: expect.any(Date) }],
          meta: { total: 21, perPage: 15, currentPage: 2, totalPages: 2, hasMore: false, from: 16, to: 21 },
        },
        {
          path: '/api/tasks',
          query: { per_page: '15', completed: 'true' },
        },
      )
    })
  })

  describe('store()', () => {
    it('creates a task when authenticated', async () => {
      const newTask = { id: 1, title: 'New Task', description: null, completed: false, userId: 1, createdAt: new Date(), updatedAt: new Date() }
      mockTaskCreate.mockResolvedValue(newTask)

      const ctx = authenticatedContext('http://api.test/api/tasks', {
        method: 'POST',
        body: JSON.stringify({ title: 'New Task' }),
        headers: { 'Content-Type': 'application/json' },
      })

      const controller = createController(ctx)
      const response = await controller.store()

      expect(response.status).toBe(201)
      const json = await response.json()
      expect(json.data.title).toBe('New Task')
    })

    it('throws validation errors for missing title', async () => {
      const ctx = authenticatedContext('http://api.test/api/tasks', {
        method: 'POST',
        body: JSON.stringify({ description: 'No title' }),
        headers: { 'Content-Type': 'application/json' },
      })

      const controller = createController(ctx)

      await expect(controller.store()).rejects.toMatchObject({
        statusCode: 422,
      })
    })
  })

  describe('show()', () => {
    it('returns task when found', async () => {
      const task = { id: 1, title: 'Task', description: 'Desc', completed: false, userId: 1, createdAt: new Date(), updatedAt: new Date() }
      mockTaskFirst.mockResolvedValue(task)

      const ctx = authenticatedContext('http://api.test/api/tasks/1', {
        method: 'GET',
      })
      ;(ctx.req as { param: (key?: string) => unknown }).param = vi.fn((key?: string) => {
        if (!key) return { id: '1' }
        return key === 'id' ? '1' : undefined
      })

      const controller = createController(ctx)
      const response = await controller.show()

      expect(response.status).toBe(200)
      const json = await response.json()
      expect(json.data.title).toBe('Task')
      expect(json.data.notificationArtifactPath).toBe('notifications/tasks/1.json')
      expect(json.data.broadcastChannels.public).toBe('tasks')
    })

    it('returns 404 when task not found', async () => {
      mockTaskFirst.mockResolvedValue(null)

      const ctx = authenticatedContext('http://api.test/api/tasks/999', {
        method: 'GET',
      })
      ;(ctx.req as { param: (key?: string) => unknown }).param = vi.fn((key?: string) => {
        if (!key) return { id: '999' }
        return key === 'id' ? '999' : undefined
      })

      const controller = createController(ctx)
      const response = await controller.show()

      expect(response.status).toBe(404)
    })
  })

  describe('update()', () => {
    it('updates task when found', async () => {
      const task = { id: 1, title: 'Task', description: 'Desc', completed: false, userId: 1, createdAt: new Date(), updatedAt: new Date() }
      mockTaskFirst.mockResolvedValue(task)
      mockTaskUpdate.mockResolvedValue(task)
      mockTaskFind.mockResolvedValue({ ...task, title: 'Updated', completed: true })

      const ctx = authenticatedContext('http://api.test/api/tasks/1', {
        method: 'PUT',
        body: JSON.stringify({ title: 'Updated', completed: true }),
        headers: { 'Content-Type': 'application/json' },
      })
      ;(ctx.req as { param: (key?: string) => unknown }).param = vi.fn((key?: string) => {
        if (!key) return { id: '1' }
        return key === 'id' ? '1' : undefined
      })

      const controller = createController(ctx)
      const response = await controller.update()

      expect(response.status).toBe(200)
      const json = await response.json()
      expect(json.data.title).toBe('Updated')
      expect(json.data.completed).toBe(true)
    })
  })

  describe('destroy()', () => {
    it('deletes task when found', async () => {
      const task = { id: 1, title: 'Task', userId: 1 }
      mockTaskFirst.mockResolvedValue(task)
      mockTaskDelete.mockResolvedValue(undefined)

      const ctx = authenticatedContext('http://api.test/api/tasks/1', {
        method: 'DELETE',
      })
      ;(ctx.req as { param: (key?: string) => unknown }).param = vi.fn((key?: string) => {
        if (!key) return { id: '1' }
        return key === 'id' ? '1' : undefined
      })

      const controller = createController(ctx)
      const response = await controller.destroy()

      expect(response.status).toBe(200)
      const json = await response.json()
      expect(json.message).toBe('Task deleted')
    })

    it('returns 404 when task not found', async () => {
      mockTaskFirst.mockResolvedValue(null)

      const ctx = authenticatedContext('http://api.test/api/tasks/999', {
        method: 'DELETE',
      })
      ;(ctx.req as { param: (key?: string) => unknown }).param = vi.fn((key?: string) => {
        if (!key) return { id: '999' }
        return key === 'id' ? '999' : undefined
      })

      const controller = createController(ctx)
      const response = await controller.destroy()

      expect(response.status).toBe(404)
    })
  })
})
