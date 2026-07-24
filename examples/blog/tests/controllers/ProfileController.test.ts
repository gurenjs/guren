import { describe, expect, it, vi } from 'vitest'
import {
  createControllerContext,
  createControllerModuleMock,
  readInertiaResponse,
} from '@guren/testing'
import type { Context } from '@guren/core'

const { mockUserWhere, mockUserUpdate, mockUserFind, mockSendEmailVerificationMail } = vi.hoisted(() => ({
  mockUserWhere: vi.fn(),
  mockUserUpdate: vi.fn(),
  mockUserFind: vi.fn(),
  mockSendEmailVerificationMail: vi.fn(),
}))

vi.mock('../../app/Models/User.js', () => ({
  User: {
    where: mockUserWhere,
    update: mockUserUpdate,
    find: mockUserFind,
  },
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
import ProfileController from '../../app/Http/Controllers/ProfileController.js'

function createAuthStub(user: unknown) {
  return {
    user: vi.fn().mockResolvedValue(user),
    login: vi.fn().mockResolvedValue(undefined),
  }
}

describe('ProfileController', () => {
  it('redirects guests to login on edit', async () => {
    const controller = new ProfileController()
    Object.defineProperty(controller, 'auth', {
      value: createAuthStub(null),
      configurable: true,
    })

    const ctx = createControllerContext('http://blog.test/profile') as unknown as Context
    controller.setContext(ctx)

    const response = await controller.edit()
    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('/login')
  })

  it('updates the profile and returns a success status', async () => {
    const controller = new ProfileController()
    Object.defineProperty(controller, 'auth', {
      value: createAuthStub({ id: 1, name: 'Ada', email: 'ada@example.com' }),
      configurable: true,
    })

    mockUserWhere.mockResolvedValue([])
    mockUserUpdate.mockResolvedValue(undefined)
    mockUserFind.mockResolvedValue({ id: 1, name: 'Ada Lovelace', email: 'ada@example.com' })

    const ctx = createControllerContext('http://blog.test/profile', {
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

    const response = await controller.update()
    const { payload } = await readInertiaResponse(response)

    expect(payload.component).toBe('profile/Edit')
    expect(payload.props.status).toBe('Profile updated successfully.')
  })

  it('clears emailVerifiedAt and sends a new verification email when the email changes', async () => {
    const controller = new ProfileController()
    Object.defineProperty(controller, 'auth', {
      value: createAuthStub({ id: 1, name: 'Ada', email: 'ada@example.com', emailVerifiedAt: new Date() }),
      configurable: true,
    })

    mockUserWhere.mockResolvedValue([])
    mockUserUpdate.mockResolvedValue(undefined)
    mockUserFind.mockResolvedValue({ id: 1, name: 'Ada', email: 'new@example.com', emailVerifiedAt: null })
    mockSendEmailVerificationMail.mockResolvedValue(undefined)

    const ctx = createControllerContext('http://blog.test/profile', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Ada',
        email: 'new@example.com',
        password: '',
        passwordConfirmation: '',
      }),
      headers: { 'Content-Type': 'application/json' },
    }, { mail: {} }) as unknown as Context

    controller.setContext(ctx)

    const response = await controller.update()
    const { payload } = await readInertiaResponse(response)

    expect(mockUserUpdate).toHaveBeenCalledWith(
      { id: 1 },
      expect.objectContaining({ email: 'new@example.com', emailVerifiedAt: null }),
    )
    expect(mockSendEmailVerificationMail).toHaveBeenCalled()
    expect(payload.props.status).toBe('Profile updated. Check your new email address for a verification link.')
  })
})
