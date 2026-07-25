import { describe, expect, it, vi } from 'vitest'
import {
  createControllerContext,
  createControllerModuleMock,
  readInertiaResponse,
} from '@guren/testing'
import type { Context } from '@guren/core'

const { mockUserWhere, mockUserUpdate } = vi.hoisted(() => ({
  mockUserWhere: vi.fn(),
  mockUserUpdate: vi.fn(),
}))

vi.mock('../../app/Models/User.js', () => ({
  User: {
    where: mockUserWhere,
    update: mockUserUpdate,
  },
}))

vi.mock('guren', () => createControllerModuleMock())
vi.mock('@guren/core', async () => {
  const actual = await vi.importActual<typeof import('@guren/core')>('@guren/core')
  return {
    ...actual,
    ...createControllerModuleMock(),
    ServiceProvider: actual.ServiceProvider,
  }
})

import ResetPasswordController from '../../app/Http/Controllers/Auth/ResetPasswordController.js'
import { passwordResetStore } from '../../app/Auth/PasswordResetStore.js'
import { createPasswordResetToken } from '@guren/core'

describe('ResetPasswordController', () => {
  it('renders the reset form with the token and email from the query string', async () => {
    const controller = new ResetPasswordController()
    const ctx = createControllerContext('http://blog.test/reset-password?token=abc&email=ada@example.com', {
      headers: { 'X-Inertia': 'true' },
    }) as unknown as Context
    controller.setContext(ctx)

    const response = await controller.show()
    const { payload } = await readInertiaResponse(response)

    expect(payload.component).toBe('auth/ResetPassword')
    expect(payload.props.token).toBe('abc')
    expect(payload.props.email).toBe('ada@example.com')
  })

  it('resets the password and redirects to /login for a valid token', async () => {
    mockUserWhere.mockResolvedValue([{ id: 1, email: 'ada@example.com' }])
    mockUserUpdate.mockResolvedValue(undefined)

    const { token } = await createPasswordResetToken('ada@example.com', passwordResetStore)

    const controller = new ResetPasswordController()
    const ctx = createControllerContext('http://blog.test/reset-password', {
      method: 'POST',
      body: JSON.stringify({
        token,
        password: 'newpassword123',
        passwordConfirmation: 'newpassword123',
      }),
      headers: { 'Content-Type': 'application/json' },
    }) as unknown as Context
    controller.setContext(ctx)

    const response = await controller.store()

    expect(mockUserUpdate).toHaveBeenCalledWith({ id: 1 }, { password: 'newpassword123' })
    expect(response.status).toBe(303)
    expect(response.headers.get('Location')).toBe('/login')
  })

  it('rejects an invalid or expired token', async () => {
    const controller = new ResetPasswordController()
    const ctx = createControllerContext('http://blog.test/reset-password', {
      method: 'POST',
      body: JSON.stringify({
        token: 'not-a-real-token',
        password: 'newpassword123',
        passwordConfirmation: 'newpassword123',
      }),
      headers: { 'Content-Type': 'application/json' },
    }) as unknown as Context
    controller.setContext(ctx)

    await expect(controller.store()).rejects.toThrow()
    expect(mockUserUpdate).not.toHaveBeenCalled()
  })

  it('rejects mismatched password confirmation', async () => {
    const controller = new ResetPasswordController()
    const ctx = createControllerContext('http://blog.test/reset-password', {
      method: 'POST',
      body: JSON.stringify({
        token: 'irrelevant',
        password: 'newpassword123',
        passwordConfirmation: 'different',
      }),
      headers: { 'Content-Type': 'application/json' },
    }) as unknown as Context
    controller.setContext(ctx)

    await expect(controller.store()).rejects.toThrow()
  })
})
