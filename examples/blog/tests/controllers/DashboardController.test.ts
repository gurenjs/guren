import { describe, expect, it, vi } from 'vitest'
import {
  createControllerContext,
  createControllerModuleMock,
  readInertiaResponse,
} from '@guren/testing'
import type { Context } from '@guren/core'

vi.mock('guren', () => createControllerModuleMock())
vi.mock('@guren/core', async () => {
  const actual = await vi.importActual<typeof import('@guren/core')>('@guren/core')
  return {
    ...actual,
    ...createControllerModuleMock(),
    ServiceProvider: actual.ServiceProvider,
  }
})
import DashboardController from '../../app/Http/Controllers/DashboardController.js'

function createAuthStub(user: unknown) {
  return {
    user: vi.fn().mockResolvedValue(user),
  }
}

describe('DashboardController', () => {
  it('returns inertia payload with the authenticated user', async () => {
    const controller = new DashboardController()
    Object.defineProperty(controller, 'auth', {
      value: createAuthStub({ id: 1, name: 'Ada' }),
      configurable: true,
    })

    const ctx = createControllerContext('http://blog.test/dashboard', {
      headers: { 'X-Inertia': 'true', Accept: 'application/json' },
    }) as unknown as Context
    controller.setContext(ctx)

    const response = await controller.index()
    const { payload } = await readInertiaResponse(response)

    expect(payload.component).toBe('dashboard/Index')
    expect(payload.props.user).toEqual({ id: 1, name: 'Ada' })
    expect(payload.url).toBe('/dashboard')
  })
})
