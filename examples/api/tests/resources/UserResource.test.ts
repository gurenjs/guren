import { describe, expect, it, vi } from 'vitest'
import { createControllerModuleMock } from '@guren/testing'

vi.mock('@guren/server', () => createControllerModuleMock())
import { UserResource } from '../../app/Http/Resources/UserResource.js'

describe('UserResource', () => {
  it('serializes basic user fields', () => {
    const user = {
      id: 1,
      name: 'Ada',
      email: 'ada@example.com',
      createdAt: new Date('2024-01-01T00:00:00Z'),
    }

    const resource = new UserResource(user as any)
    const payload = resource.toJSON()

    expect(payload).toEqual({
      id: 1,
      name: 'Ada',
      email: 'ada@example.com',
      createdAt: user.createdAt.toISOString(),
    })
  })
})
