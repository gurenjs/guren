import { describe, expect, it, vi } from 'vitest'
import {
  createControllerContext,
  createControllerModuleMock,
  readInertiaResponse,
} from '@guren/testing'
import type { Context } from '@guren/core'

const { mockUserWhere, mockUserCreate } = vi.hoisted(() => ({
  mockUserWhere: vi.fn(),
  mockUserCreate: vi.fn(),
}))

vi.mock('../../app/Models/User.js', () => ({
  User: {
    where: mockUserWhere,
    create: mockUserCreate,
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

import OAuthController from '../../app/Http/Controllers/Auth/OAuthController.js'

function createOAuthStub() {
  return {
    authorize: vi.fn().mockResolvedValue({ url: 'https://github.com/login/oauth/authorize?client_id=abc' }),
    handleCallback: vi.fn(),
  }
}

function createController() {
  const controller = new OAuthController()
  Object.defineProperty(controller, 'auth', {
    value: {
      session: vi.fn().mockReturnValue({ regenerate: vi.fn() }),
      login: vi.fn().mockResolvedValue(undefined),
    },
    configurable: true,
  })
  return controller
}

describe('OAuthController', () => {
  describe('redirectToProvider()', () => {
    it('redirects to the provider authorization URL', async () => {
      const oauth = createOAuthStub()
      const controller = createController()
      const ctx = createControllerContext('http://blog.test/auth/github', {}, { oauth }) as unknown as Context
      controller.setContext(ctx)
      ;(ctx as unknown as { req: { param: () => Record<string, string> } }).req.param = () => ({ provider: 'github' })

      const response = await controller.redirectToProvider()

      expect(oauth.authorize).toHaveBeenCalledWith('github', { redirectTo: undefined })
      expect(response.status).toBe(302)
      expect(response.headers.get('Location')).toBe('https://github.com/login/oauth/authorize?client_id=abc')
    })
  })

  describe('callback()', () => {
    it('logs in an existing user matched by provider identity', async () => {
      const oauth = createOAuthStub()
      oauth.handleCallback.mockResolvedValue({
        profile: { id: 'gh-1', email: 'ada@example.com', name: 'Ada' },
        redirectTo: null,
      })
      mockUserWhere.mockResolvedValue([{ id: 1, email: 'ada@example.com', githubId: 'gh-1' }])

      const controller = createController()
      const ctx = createControllerContext('http://blog.test/auth/github/callback?code=abc&state=xyz', {}, { oauth }) as unknown as Context
      controller.setContext(ctx)
      ;(ctx as unknown as { req: { param: () => Record<string, string> } }).req.param = () => ({ provider: 'github' })

      const response = await controller.callback()

      expect(mockUserCreate).not.toHaveBeenCalled()
      expect(response.status).toBe(302)
      expect(response.headers.get('Location')).toBe('/dashboard')
    })

    it('creates a new account when no existing user matches', async () => {
      const oauth = createOAuthStub()
      oauth.handleCallback.mockResolvedValue({
        profile: { id: 'gh-2', email: 'new@example.com', name: 'New Person' },
        redirectTo: null,
      })
      mockUserWhere.mockResolvedValue([])
      mockUserCreate.mockResolvedValue({ id: 2, email: 'new@example.com', githubId: 'gh-2' })

      const controller = createController()
      const ctx = createControllerContext('http://blog.test/auth/github/callback?code=abc&state=xyz', {}, { oauth }) as unknown as Context
      controller.setContext(ctx)
      ;(ctx as unknown as { req: { param: () => Record<string, string> } }).req.param = () => ({ provider: 'github' })

      const response = await controller.callback()

      expect(mockUserCreate).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'New Person', email: 'new@example.com', githubId: 'gh-2' }),
      )
      expect(response.status).toBe(302)
      expect(response.headers.get('Location')).toBe('/dashboard')
    })

    it('rejects when an account with the same email already exists under a different identity', async () => {
      const oauth = createOAuthStub()
      oauth.handleCallback.mockResolvedValue({
        profile: { id: 'gh-3', email: 'existing@example.com', name: 'Existing' },
        redirectTo: null,
      })
      mockUserWhere
        .mockResolvedValueOnce([]) // no match by githubId
        .mockResolvedValueOnce([{ id: 9, email: 'existing@example.com' }]) // match by email

      const controller = createController()
      const ctx = createControllerContext('http://blog.test/auth/github/callback?code=abc&state=xyz', {}, { oauth }) as unknown as Context
      controller.setContext(ctx)
      ;(ctx as unknown as { req: { param: () => Record<string, string> } }).req.param = () => ({ provider: 'github' })

      await expect(controller.callback()).rejects.toThrow()
      expect(mockUserCreate).not.toHaveBeenCalled()
    })

    it('rejects when the provider does not return an email address', async () => {
      const oauth = createOAuthStub()
      oauth.handleCallback.mockResolvedValue({
        profile: { id: 'gh-4', email: undefined, name: 'No Email' },
        redirectTo: null,
      })

      const controller = createController()
      const ctx = createControllerContext('http://blog.test/auth/github/callback?code=abc&state=xyz', {}, { oauth }) as unknown as Context
      controller.setContext(ctx)
      ;(ctx as unknown as { req: { param: () => Record<string, string> } }).req.param = () => ({ provider: 'github' })

      await expect(controller.callback()).rejects.toThrow()
    })
  })
})
