import { describe, expect, it, vi } from 'vitest'
import {
  createControllerContext,
  createGurenControllerModule,
  readInertiaResponse,
} from '@guren/testing'
import type { Context } from '@guren/core'

vi.mock('guren', () => createGurenControllerModule())
vi.mock('@guren/core', () => createGurenControllerModule())
vi.mock('@guren/server', () => createGurenControllerModule())

import LoginController from '../../app/Http/Controllers/Auth/LoginController.js'

function createAuthStub(user: unknown = null) {
  const session = {
    regenerate: vi.fn(),
    invalidate: vi.fn(),
  }

  return {
    user: vi.fn().mockResolvedValue(user),
    session: vi.fn().mockReturnValue(session),
    attempt: vi.fn(),
    logout: vi.fn(),
  }
}

describe('LoginController', () => {
  it('returns JSON payload for Inertia visits', async () => {
    const controller = new LoginController()
    ;(controller as unknown as { auth: ReturnType<typeof createAuthStub> }).auth = createAuthStub()
    const ctx = createControllerContext('http://blog.test/login?email=jane@example.com', {
      headers: {
        'X-Inertia': 'true',
        Accept: 'application/json',
      },
    }) as unknown as Context
    controller.setContext(ctx)

    const response = await controller.show(ctx)
    const { format, payload } = await readInertiaResponse(response)

    expect(response.status).toBe(200)
    expect(format).toBe('json')
    expect(payload.component).toBe('auth/Login')
    expect(payload.props.email).toBe('jane@example.com')
    expect(payload.url).toBe('/login')
  })

  it('embeds Inertia page data in HTML for full visits', async () => {
    const controller = new LoginController()
    ;(controller as unknown as { auth: ReturnType<typeof createAuthStub> }).auth = createAuthStub()
    const ctx = createControllerContext('http://blog.test/login') as unknown as Context
    controller.setContext(ctx)

    const response = await controller.show(ctx)
    const { format, payload, body } = await readInertiaResponse(response)

    expect(response.status).toBe(200)
    expect(format).toBe('html')
    expect(body).toContain('data-page=')
    expect(payload.component).toBe('auth/Login')
  })
})
