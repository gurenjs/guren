import { describe, expect, it, vi } from 'vitest'
import { createControllerModuleMock } from '@guren/testing/controller'

// Async like every other mock in this suite: awaiting the real module settles
// the server/hono graph inside the factory, rather than leaving it to load
// while vitest is tearing the environment down.
vi.mock('@guren/core', async () => {
  const actual = await vi.importActual<typeof import('@guren/core')>('@guren/core')
  return { ...actual, ...createControllerModuleMock() }
})
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
