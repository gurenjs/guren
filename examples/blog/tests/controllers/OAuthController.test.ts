import { describe, expect, it, vi } from 'vitest'
import {
  createControllerContext,
  createControllerModuleMock,
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

/** Enough of a Session for the controller's state binding to round-trip. */
function createSessionStub() {
  const data = new Map<string, unknown>()
  return {
    regenerate: vi.fn(),
    set: vi.fn((key: string, value: unknown) => { data.set(key, value) }),
    get: vi.fn((key: string) => data.get(key)),
    forget: vi.fn((key: string) => { data.delete(key) }),
  }
}

function createController(session = createSessionStub()) {
  const controller = new OAuthController()
  Object.defineProperty(controller, 'auth', {
    value: {
      session: vi.fn().mockReturnValue(session),
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
      const session = createSessionStub()
      const controller = createController(session)
      const ctx = createControllerContext('http://blog.test/auth/github', {}, { oauth }) as unknown as Context
      controller.setContext(ctx)
      ;(ctx as unknown as { req: { param: () => Record<string, string> } }).req.param = () => ({ provider: 'github' })

      const response = await controller.redirectToProvider()

      // The session binds `state` to this browser; without it an attacker can
      // walk a visitor through the callback into the attacker's account.
      expect(oauth.authorize).toHaveBeenCalledWith('github', {
        redirectTo: undefined,
        session,
      })
      expect(response.status).toBe(302)
      expect(response.headers.get('Location')).toBe('https://github.com/login/oauth/authorize?client_id=abc')
    })

    // A missing session is an unbound flow; forwarding it untouched keeps a
    // session-less setup working.
    it('passes the missing session through so the flow stays unbound', async () => {
      const oauth = createOAuthStub()
      // `null`, not `undefined` — the default parameter would substitute a stub.
      const controller = createController(null as unknown as ReturnType<typeof createSessionStub>)
      const ctx = createControllerContext('http://blog.test/auth/github', {}, { oauth }) as unknown as Context
      controller.setContext(ctx)
      ;(ctx as unknown as { req: { param: () => Record<string, string> } }).req.param = () => ({ provider: 'github' })

      const response = await controller.redirectToProvider()

      expect(oauth.authorize).toHaveBeenCalledWith('github', { redirectTo: undefined, session: null })
      expect(response.status).toBe(302)
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

      const session = createSessionStub()
      const controller = createController(session)
      const ctx = createControllerContext('http://blog.test/auth/github/callback?code=abc&state=xyz', {}, { oauth }) as unknown as Context
      controller.setContext(ctx)
      ;(ctx as unknown as { req: { param: () => Record<string, string> } }).req.param = () => ({ provider: 'github' })

      const response = await controller.callback()

      // The binding is read back from the session authorize() stored it in.
      expect(oauth.handleCallback).toHaveBeenCalledWith('github', { code: 'abc', state: 'xyz', session })
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
        expect.objectContaining({
          name: 'New Person',
          email: 'new@example.com',
          githubId: 'gh-2',
          emailVerifiedAt: expect.any(Date),
        }),
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

    it('refuses to create an account from an address the provider has not verified', async () => {
      const oauth = createOAuthStub()
      oauth.handleCallback.mockResolvedValue({
        profile: { id: 'gh-6', email: 'unverified@example.com', name: 'Unverified', emailVerified: false },
        redirectTo: null,
      })
      mockUserWhere.mockResolvedValue([])

      const controller = createController()
      const ctx = createControllerContext('http://blog.test/auth/github/callback?code=abc&state=xyz', {}, { oauth }) as unknown as Context
      controller.setContext(ctx)
      ;(ctx as unknown as { req: { param: () => Record<string, string> } }).req.param = () => ({ provider: 'github' })

      await expect(controller.callback()).rejects.toThrow()
      expect(mockUserCreate).not.toHaveBeenCalled()
    })

    it('signs in an already-linked account even when the provider reports it unverified', async () => {
      const oauth = createOAuthStub()
      oauth.handleCallback.mockResolvedValue({
        profile: { id: 'gh-7', email: 'linked@example.com', name: 'Linked', emailVerified: false },
        redirectTo: null,
      })
      mockUserWhere.mockResolvedValue([{ id: 7, email: 'linked@example.com', githubId: 'gh-7' }])

      const controller = createController()
      const ctx = createControllerContext('http://blog.test/auth/github/callback?code=abc&state=xyz', {}, { oauth }) as unknown as Context
      controller.setContext(ctx)
      ;(ctx as unknown as { req: { param: () => Record<string, string> } }).req.param = () => ({ provider: 'github' })

      const response = await controller.callback()

      expect(mockUserCreate).not.toHaveBeenCalled()
      expect(response.status).toBe(302)
    })

    it('lowercases the provider email before matching and creating accounts', async () => {
      const oauth = createOAuthStub()
      oauth.handleCallback.mockResolvedValue({
        profile: { id: 'gh-5', email: 'Mixed@Example.com', name: 'Mixed Case' },
        redirectTo: null,
      })
      mockUserWhere.mockResolvedValue([])
      mockUserCreate.mockResolvedValue({ id: 3, email: 'mixed@example.com', githubId: 'gh-5' })

      const controller = createController()
      const ctx = createControllerContext('http://blog.test/auth/github/callback?code=abc&state=xyz', {}, { oauth }) as unknown as Context
      controller.setContext(ctx)
      ;(ctx as unknown as { req: { param: () => Record<string, string> } }).req.param = () => ({ provider: 'github' })

      const response = await controller.callback()

      expect(mockUserCreate).toHaveBeenCalledWith(expect.objectContaining({ email: 'mixed@example.com' }))
      expect(response.status).toBe(302)
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
