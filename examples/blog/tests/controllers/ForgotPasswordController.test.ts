import { describe, expect, it, vi } from 'vitest'
import {
  createControllerContext,
  createControllerModuleMock,
  readInertiaResponse,
} from '@guren/testing'
import type { Context } from '@guren/core'

const { mockUserWhere, mockDispatch } = vi.hoisted(() => ({
  mockUserWhere: vi.fn(),
  mockDispatch: vi.fn(),
}))

vi.mock('../../app/Models/User.js', () => ({
  User: { where: mockUserWhere },
}))

vi.mock('../../app/Jobs/SendPasswordResetEmailJob.js', () => ({
  SendPasswordResetEmailJob: { dispatch: mockDispatch },
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

import ForgotPasswordController from '../../app/Http/Controllers/Auth/ForgotPasswordController.js'

const STATUS_MESSAGE = "If an account exists for that email, we've sent a password reset link."

describe('ForgotPasswordController', () => {
  it('renders the forgot-password form', async () => {
    const controller = new ForgotPasswordController()
    const ctx = createControllerContext('http://blog.test/forgot-password', {
      headers: { 'X-Inertia': 'true' },
    }) as unknown as Context
    controller.setContext(ctx)

    const response = await controller.show()
    const { payload } = await readInertiaResponse(response)

    expect(response.status).toBe(200)
    expect(payload.component).toBe('auth/ForgotPassword')
  })

  it('sends a reset email when the account exists', async () => {
    mockUserWhere.mockResolvedValue([{ id: 1, email: 'ada@example.com' }])
    mockDispatch.mockResolvedValue('job-id')

    const controller = new ForgotPasswordController()
    const ctx = createControllerContext('http://blog.test/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email: 'ada@example.com' }),
      headers: { 'Content-Type': 'application/json' },
    }) as unknown as Context
    controller.setContext(ctx)

    const response = await controller.store()
    const { payload } = await readInertiaResponse(response)

    expect(mockDispatch).toHaveBeenCalledWith(expect.objectContaining({ email: 'ada@example.com' }))
    expect(payload.props.status).toBe(STATUS_MESSAGE)
  })

  it('returns the same status message when the account does not exist, without sending mail', async () => {
    mockUserWhere.mockResolvedValue([])

    const controller = new ForgotPasswordController()
    const ctx = createControllerContext('http://blog.test/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email: 'nobody@example.com' }),
      headers: { 'Content-Type': 'application/json' },
    }) as unknown as Context
    controller.setContext(ctx)

    const response = await controller.store()
    const { payload } = await readInertiaResponse(response)

    expect(mockDispatch).not.toHaveBeenCalled()
    expect(payload.props.status).toBe(STATUS_MESSAGE)
  })
})
