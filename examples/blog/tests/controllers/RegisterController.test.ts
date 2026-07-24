import { describe, expect, it, vi } from 'vitest'
import {
  createControllerContext,
  createControllerModuleMock,
  readInertiaResponse,
} from '@guren/testing'
import type { Context } from '@guren/core'

const { mockUserWhere, mockUserCreate, mockDispatch, mockSendEmailVerificationMail } = vi.hoisted(() => ({
  mockUserWhere: vi.fn(),
  mockUserCreate: vi.fn(),
  mockDispatch: vi.fn(),
  mockSendEmailVerificationMail: vi.fn(),
}))

vi.mock('../../app/Models/User.js', () => ({
  User: {
    where: mockUserWhere,
    create: mockUserCreate,
  },
}))

vi.mock('../../app/Jobs/SendWelcomeEmailJob.js', () => ({
  SendWelcomeEmailJob: { dispatch: mockDispatch },
}))

vi.mock('../../app/Mail/EmailVerificationMail.js', () => ({
  sendEmailVerificationMail: mockSendEmailVerificationMail,
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

import RegisterController from '../../app/Http/Controllers/Auth/RegisterController.js'

function createAuthStub() {
  return {
    session: vi.fn().mockReturnValue({ regenerate: vi.fn() }),
    login: vi.fn().mockResolvedValue(undefined),
  }
}

function createController() {
  const controller = new RegisterController()
  Object.defineProperty(controller, 'auth', {
    value: createAuthStub(),
    configurable: true,
  })
  return controller
}

describe('RegisterController', () => {
  it('renders the registration form', async () => {
    const controller = createController()
    const ctx = createControllerContext('http://blog.test/register', {
      headers: { 'X-Inertia': 'true' },
    }) as unknown as Context
    controller.setContext(ctx)

    const response = await controller.show()
    const { payload } = await readInertiaResponse(response)

    expect(response.status).toBe(200)
    expect(payload.component).toBe('auth/Register')
  })

  it('creates a user, dispatches the welcome email job, sends a verification email, and redirects to /verify-email', async () => {
    mockUserWhere.mockResolvedValue([])
    mockUserCreate.mockResolvedValue({ id: 1, name: 'Ada Lovelace', email: 'ada@example.com' })
    mockDispatch.mockResolvedValue('job-id')
    mockSendEmailVerificationMail.mockResolvedValue(undefined)

    const controller = createController()
    const ctx = createControllerContext('http://blog.test/register', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        password: 'password123',
        passwordConfirmation: 'password123',
      }),
      headers: { 'Content-Type': 'application/json' },
    }, { mail: {} }) as unknown as Context
    controller.setContext(ctx)

    const response = await controller.store()

    expect(mockUserCreate).toHaveBeenCalledWith({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      password: 'password123',
    })
    expect(mockDispatch).toHaveBeenCalledWith({ userId: 1 })
    expect(mockSendEmailVerificationMail).toHaveBeenCalled()
    expect(response.status).toBe(303)
    expect(response.headers.get('Location')).toBe('/verify-email')
  })

  it('rejects registration when the email is already taken', async () => {
    mockUserWhere.mockResolvedValue([{ id: 5, email: 'ada@example.com' }])

    const controller = createController()
    const ctx = createControllerContext('http://blog.test/register', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        password: 'password123',
        passwordConfirmation: 'password123',
      }),
      headers: { 'Content-Type': 'application/json' },
    }) as unknown as Context
    controller.setContext(ctx)

    await expect(controller.store()).rejects.toThrow()
    expect(mockUserCreate).not.toHaveBeenCalled()
  })

  it('rejects registration when passwords do not match', async () => {
    const controller = createController()
    const ctx = createControllerContext('http://blog.test/register', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        password: 'password123',
        passwordConfirmation: 'different',
      }),
      headers: { 'Content-Type': 'application/json' },
    }) as unknown as Context
    controller.setContext(ctx)

    await expect(controller.store()).rejects.toThrow()
  })
})
