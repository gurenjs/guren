import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  createControllerContext,
  createControllerModuleMock,
} from '@guren/testing'
import type { Context } from '@guren/server'

const {
  mockGetApiToken,
  mockTaskCreate,
  mockTaskFirst,
  mockTaskFind,
  mockTaskPaginate,
  mockTaskUpdate,
  mockTaskDelete,
} = vi.hoisted(() => ({
  mockGetApiToken: vi.fn(),
  mockTaskCreate: vi.fn(),
  mockTaskFirst: vi.fn(),
  mockTaskFind: vi.fn(),
  mockTaskPaginate: vi.fn(),
  mockTaskUpdate: vi.fn(),
  mockTaskDelete: vi.fn(),
}))

vi.mock('@guren/server', () => ({
  ...createControllerModuleMock(),
  getApiToken: mockGetApiToken,
  paginate: vi.fn().mockReturnValue({
    withPath: vi.fn().mockReturnThis(),
    withQuery: vi.fn().mockReturnThis(),
    toResource: vi.fn().mockReturnValue({
      data: [],
      meta: { currentPage: 1, lastPage: 1, perPage: 15, total: 0 },
      links: {},
    }),
  }),
}))

vi.mock('../app/Models/Task.js', () => ({
  Task: {
    create: mockTaskCreate,
    first: mockTaskFirst,
    find: mockTaskFind,
    paginate: mockTaskPaginate,
    update: mockTaskUpdate,
    delete: mockTaskDelete,
  },
}))

import TaskController from '../app/Http/Controllers/TaskController.js'

function createController(ctx: Context): TaskController {
  const controller = new TaskController()
  controller.setContext(ctx)
  return controller
}

describe('TaskController', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('index()', () => {
    it('returns 401 without authentication', async () => {
      mockGetApiToken.mockReturnValue(null)

      const ctx = createControllerContext('http://api.test/api/tasks', {
        method: 'GET',
      }) as unknown as Context

      const controller = createController(ctx)
      const response = await controller.index()

      expect(response.status).toBe(401)
    })

    it('returns paginated tasks when authenticated', async () => {
      mockGetApiToken.mockReturnValue({ userId: 1, abilities: ['*'], token: {} as never })
      mockTaskPaginate.mockResolvedValue({
        data: [{ id: 1, title: 'Task 1', completed: false, createdAt: new Date(), updatedAt: new Date() }],
        meta: { total: 1, perPage: 15, currentPage: 1, totalPages: 1, hasMore: false, from: 1, to: 1 },
      })

      const ctx = createControllerContext('http://api.test/api/tasks', {
        method: 'GET',
      }) as unknown as Context

      const controller = createController(ctx)
      const response = await controller.index()

      expect(response.status).toBe(200)
    })
  })

  describe('store()', () => {
    it('creates a task when authenticated', async () => {
      mockGetApiToken.mockReturnValue({ userId: 1, abilities: ['*'], token: {} as never })
      const newTask = { id: 1, title: 'New Task', description: null, completed: false, userId: 1, createdAt: new Date(), updatedAt: new Date() }
      mockTaskCreate.mockResolvedValue(newTask)

      const ctx = createControllerContext('http://api.test/api/tasks', {
        method: 'POST',
        body: JSON.stringify({ title: 'New Task' }),
        headers: { 'Content-Type': 'application/json' },
      }) as unknown as Context

      const controller = createController(ctx)
      const response = await controller.store()

      expect(response.status).toBe(201)
      const json = await response.json()
      expect(json.data.title).toBe('New Task')
    })

    it('returns validation errors for missing title', async () => {
      mockGetApiToken.mockReturnValue({ userId: 1, abilities: ['*'], token: {} as never })

      const ctx = createControllerContext('http://api.test/api/tasks', {
        method: 'POST',
        body: JSON.stringify({ description: 'No title' }),
        headers: { 'Content-Type': 'application/json' },
      }) as unknown as Context

      const controller = createController(ctx)
      const response = await controller.store()

      expect(response.status).toBe(422)
      const json = await response.json()
      expect(json.errors).toBeDefined()
    })
  })

  describe('show()', () => {
    it('returns task when found', async () => {
      mockGetApiToken.mockReturnValue({ userId: 1, abilities: ['*'], token: {} as never })
      const task = { id: 1, title: 'Task', description: 'Desc', completed: false, userId: 1, createdAt: new Date(), updatedAt: new Date() }
      mockTaskFirst.mockResolvedValue(task)

      const ctx = createControllerContext('http://api.test/api/tasks/1', {
        method: 'GET',
      }) as unknown as Context
      ;(ctx.req as { param: (key: string) => string }).param = vi.fn().mockReturnValue('1')

      const controller = createController(ctx)
      const response = await controller.show()

      expect(response.status).toBe(200)
      const json = await response.json()
      expect(json.data.title).toBe('Task')
    })

    it('returns 404 when task not found', async () => {
      mockGetApiToken.mockReturnValue({ userId: 1, abilities: ['*'], token: {} as never })
      mockTaskFirst.mockResolvedValue(null)

      const ctx = createControllerContext('http://api.test/api/tasks/999', {
        method: 'GET',
      }) as unknown as Context
      ;(ctx.req as { param: (key: string) => string }).param = vi.fn().mockReturnValue('999')

      const controller = createController(ctx)
      const response = await controller.show()

      expect(response.status).toBe(404)
    })
  })

  describe('update()', () => {
    it('updates task when found', async () => {
      mockGetApiToken.mockReturnValue({ userId: 1, abilities: ['*'], token: {} as never })
      const task = { id: 1, title: 'Task', description: 'Desc', completed: false, userId: 1, createdAt: new Date(), updatedAt: new Date() }
      mockTaskFirst.mockResolvedValue(task)
      mockTaskUpdate.mockResolvedValue(task)
      mockTaskFind.mockResolvedValue({ ...task, title: 'Updated', completed: true })

      const ctx = createControllerContext('http://api.test/api/tasks/1', {
        method: 'PUT',
        body: JSON.stringify({ title: 'Updated', completed: true }),
        headers: { 'Content-Type': 'application/json' },
      }) as unknown as Context
      ;(ctx.req as { param: (key: string) => string }).param = vi.fn().mockReturnValue('1')

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
      mockGetApiToken.mockReturnValue({ userId: 1, abilities: ['*'], token: {} as never })
      const task = { id: 1, title: 'Task', userId: 1 }
      mockTaskFirst.mockResolvedValue(task)
      mockTaskDelete.mockResolvedValue(undefined)

      const ctx = createControllerContext('http://api.test/api/tasks/1', {
        method: 'DELETE',
      }) as unknown as Context
      ;(ctx.req as { param: (key: string) => string }).param = vi.fn().mockReturnValue('1')

      const controller = createController(ctx)
      const response = await controller.destroy()

      expect(response.status).toBe(200)
      const json = await response.json()
      expect(json.message).toBe('Task deleted')
    })

    it('returns 404 when task not found', async () => {
      mockGetApiToken.mockReturnValue({ userId: 1, abilities: ['*'], token: {} as never })
      mockTaskFirst.mockResolvedValue(null)

      const ctx = createControllerContext('http://api.test/api/tasks/999', {
        method: 'DELETE',
      }) as unknown as Context
      ;(ctx.req as { param: (key: string) => string }).param = vi.fn().mockReturnValue('999')

      const controller = createController(ctx)
      const response = await controller.destroy()

      expect(response.status).toBe(404)
    })
  })
})
