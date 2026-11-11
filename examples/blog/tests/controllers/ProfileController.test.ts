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

vi.mock('@guren/core', async () => {
  const actual = await vi.importActual<typeof import('@guren/core')>('@guren/core')
  return {
    ...actual,
    ...createControllerModuleMock(),
  }
})
import ProfileController from '../../app/Http/Controllers/ProfileController.js'

function createAuthStub(user: unknown, validate = vi.fn().mockResolvedValue(user)) {
  return {
    user: vi.fn().mockResolvedValue(user),
    login: vi.fn().mockResolvedValue(undefined),
    guard: vi.fn(() => ({ validate })),
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
        currentPassword: 'old-password',
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
        currentPassword: 'old-password',
      }),
      headers: { 'Content-Type': 'application/json' },
    }, { mail: {} }) as unknown as Context

    controller.setContext(ctx)

    const response = await controller.update()
    const { payload } = await readInertiaResponse(response)

    expect(mockUserUpdate).toHaveBeenCalledWith(
      { id: 1 },
      { name: 'Ada', email: 'new@example.com' },
      { set: { emailVerifiedAt: null } },
    )
    expect(mockSendEmailVerificationMail).toHaveBeenCalled()
    expect(payload.props.status).toBe('Profile updated. Check your new email address for a verification link.')
  })

  const changes = [
    ['a password change', { email: 'ada@example.com', password: 'attacker-chosen', passwordConfirmation: 'attacker-chosen' }],
    ['an email change', { email: 'attacker@example.com', password: '', passwordConfirmation: '' }],
  ] as const
  const refusals = [
    ['without the current password', '', 'Enter your current password to make this change.'],
    ['with a wrong current password', 'wrong-password', 'The current password is incorrect.'],
  ] as const
  for (const [change, fields] of changes) {
    for (const [label, currentPassword, message] of refusals) {
      it(`refuses ${change} ${label} and leaves the account and session alone`, async () => {
        const controller = new ProfileController()
        const validate = vi.fn().mockResolvedValue(null)
        const auth = createAuthStub({ id: 1, name: 'Ada', email: 'ada@example.com' }, validate)
        Object.defineProperty(controller, 'auth', { value: auth, configurable: true })
        mockUserUpdate.mockClear()
        mockUserWhere.mockClear()

        const ctx = createControllerContext('http://blog.test/profile', {
          method: 'POST',
          body: JSON.stringify({ name: 'Ada', ...fields, currentPassword }),
          headers: { 'Content-Type': 'application/json' },
        }) as unknown as Context
        controller.setContext(ctx)

        await expect(controller.update()).rejects.toMatchObject({ errors: { currentPassword: [message] } })
        expect(validate).toHaveBeenCalledTimes(currentPassword === '' ? 0 : 1)
        // Unqualified, a Bearer request would resolve the token guard, whose validate() throws.
        if (currentPassword !== '') expect(auth.guard).toHaveBeenCalledWith('web')
        expect(mockUserWhere).not.toHaveBeenCalled()
        expect(mockUserUpdate).not.toHaveBeenCalled()
        expect(auth.login).not.toHaveBeenCalled()
      })
    }
  }

  it('treats an address differing only in case as unchanged: no password, no new verification', async () => {
    const controller = new ProfileController()
    const validate = vi.fn()
    Object.defineProperty(controller, 'auth', {
      value: createAuthStub({ id: 1, name: 'Ada', email: 'Ada@Example.com' }, validate),
      configurable: true,
    })
    mockUserWhere.mockResolvedValue([])
    mockUserUpdate.mockReset().mockResolvedValue(undefined)
    mockUserFind.mockResolvedValue({ id: 1, name: 'Ada Lovelace', email: 'ada@example.com' })
    mockSendEmailVerificationMail.mockClear()

    const ctx = createControllerContext('http://blog.test/profile', {
      method: 'POST',
      body: JSON.stringify({ name: 'Ada Lovelace', email: 'ada@example.com', password: '', passwordConfirmation: '' }),
      headers: { 'Content-Type': 'application/json' },
    }) as unknown as Context
    controller.setContext(ctx)

    const response = await controller.update()
    const { payload } = await readInertiaResponse(response)
    expect(validate).not.toHaveBeenCalled()
    expect(mockUserUpdate).toHaveBeenCalledWith({ id: 1 }, { name: 'Ada Lovelace', email: 'ada@example.com' })
    expect(mockSendEmailVerificationMail).not.toHaveBeenCalled()
    expect(payload.props.status).toBe('Profile updated successfully.')
  })
})
