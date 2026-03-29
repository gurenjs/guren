import { describe, expect, it, vi } from 'vitest'
import { createControllerModuleMock } from '@guren/testing/controller'

vi.mock('@guren/core', () => createControllerModuleMock())
import { TaskResource } from '../../app/Http/Resources/TaskResource.js'

describe('TaskResource', () => {
  it('serializes task fields and omits unloaded owner', () => {
    const task = {
      id: 1,
      title: 'Task',
      description: 'Details',
      completed: false,
      createdAt: new Date('2024-01-01T00:00:00Z'),
      updatedAt: new Date('2024-01-02T00:00:00Z'),
    }

    const resource = new TaskResource(task as any)
    const payload = resource.toJSON()

    expect(payload.owner).toBeUndefined()
    expect(payload.title).toBe('Task')
    expect(payload.createdAt).toBe(task.createdAt.toISOString())
  })

  it('includes owner when loaded', () => {
    const task = {
      id: 2,
      title: 'Task',
      description: null,
      completed: true,
      createdAt: new Date('2024-01-01T00:00:00Z'),
      updatedAt: new Date('2024-01-02T00:00:00Z'),
      owner: { id: 5, name: 'Sam' },
    }

    const resource = new TaskResource(task as any)
    const payload = resource.toJSON()

    expect(payload.owner).toEqual({ id: 5, name: 'Sam' })
  })
})
