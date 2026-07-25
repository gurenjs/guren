import { describe, expect, it, vi } from 'vitest'
import {
  createControllerContext,
  createControllerModuleMock,
  readInertiaResponse,
} from '@guren/testing'
import type { Context } from '@guren/core'

const { mockUserUpdate, mockSendEmailVerificationMail } = vi.hoisted(() => ({
  mockUserUpdate: vi.fn(),
  mockSendEmailVerificationMail: vi.fn(),
}))

vi.mock('../../app/Models/User.js', () => ({
  User: { update: mockUserUpdate },
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

import VerifyEmailController from '../../app/Http/Controllers/Auth/VerifyEmailController.js'
import { emailVerificationStore } from '../../app/Auth/EmailVerificationStore.js'
import { createEmailVerificationToken } from '@guren/core'

function createController(user: unknown) {
  const controller = new VerifyEmailController()
  Object.defineProperty(controller, 'auth', {
    value: { userOrFail: vi.fn().mockResolvedValue(user) },
    configurable: true,
  })
  return controller
}

describe('VerifyEmailController', () => {
  describe('notice()', () => {
    it('redirects to /dashboard when the email is already verified', async () => {
      const controller = createController({ id: 1, email: 'ada@example.com', emailVerifiedAt: new Date() })
      const ctx = createControllerContext('http://blog.test/verify-email') as unknown as Context
      controller.setContext(ctx)

      const response = await controller.notice()

      expect(response.status).toBe(302)
      expect(response.headers.get('Location')).toBe('/dashboard')
    })

    it('renders the notice page when the email is not verified', async () => {
      const controller = createController({ id: 1, email: 'ada@example.com', emailVerifiedAt: null })
      const ctx = createControllerContext('http://blog.test/verify-email', {
        headers: { 'X-Inertia': 'true' },
      }) as unknown as Context
      controller.setContext(ctx)

      const response = await controller.notice()
      const { payload } = await readInertiaResponse(response)

      expect(payload.component).toBe('auth/VerifyEmail')
    })
  })

  describe('resend()', () => {
    it('sends a new verification email when unverified', async () => {
      mockSendEmailVerificationMail.mockResolvedValue(undefined)
      const controller = createController({ id: 1, email: 'ada@example.com', emailVerifiedAt: null })
      const ctx = createControllerContext('http://blog.test/verify-email', {
        method: 'POST',
        headers: { 'X-Inertia': 'true' },
      }) as unknown as Context
      controller.setContext(ctx)

      const response = await controller.resend()
      const { payload } = await readInertiaResponse(response)

      expect(mockSendEmailVerificationMail).toHaveBeenCalled()
      expect(payload.props.status).toBe('A new verification link has been sent to your email address.')
    })

    it('does not send mail when already verified', async () => {
      const controller = createController({ id: 1, email: 'ada@example.com', emailVerifiedAt: new Date() })
      const ctx = createControllerContext('http://blog.test/verify-email', {
        method: 'POST',
        headers: { 'X-Inertia': 'true' },
      }) as unknown as Context
      controller.setContext(ctx)

      await controller.resend()

      expect(mockSendEmailVerificationMail).not.toHaveBeenCalled()
    })
  })

  describe('confirm()', () => {
    it('verifies the email and redirects to /dashboard for a valid token', async () => {
      mockUserUpdate.mockResolvedValue(undefined)
      const { token } = await createEmailVerificationToken('ada@example.com', emailVerificationStore)

      const controller = createController({ id: 1, email: 'ada@example.com', emailVerifiedAt: null })
      const ctx = createControllerContext(`http://blog.test/verify-email/confirm?token=${token}`) as unknown as Context
      controller.setContext(ctx)

      const response = await controller.confirm()

      expect(mockUserUpdate).toHaveBeenCalledWith({ email: 'ada@example.com' }, { emailVerifiedAt: expect.any(Date) })
      expect(response.status).toBe(302)
      expect(response.headers.get('Location')).toBe('/dashboard')
    })

    it('shows an expired message for an invalid token', async () => {
      const controller = createController({ id: 1, email: 'ada@example.com', emailVerifiedAt: null })
      const ctx = createControllerContext('http://blog.test/verify-email/confirm?token=not-real', {
        headers: { 'X-Inertia': 'true' },
      }) as unknown as Context
      controller.setContext(ctx)

      const response = await controller.confirm()
      const { payload } = await readInertiaResponse(response)

      expect(mockUserUpdate).not.toHaveBeenCalled()
      expect(payload.props.status).toBe('This verification link is invalid or has expired. Request a new one below.')
    })
  })
})
