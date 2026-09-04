import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createControllerContext,
  createControllerModuleMock,
  type ControllerContext,
} from '@guren/testing'
import type { Context } from '@guren/core'

vi.mock('@guren/core', () => {
  const mock = createControllerModuleMock()
  // The module mock has no AuthorizationException; a 403-carrying stand-in
  // keeps admin-allowlist working under it.
  class AuthorizationException extends Error {
    statusCode = 403
  }
  return { ...mock, AuthorizationException }
})

import OAuthController from './OAuthController.js'
import { User } from '../../../Models/User.js'

interface FakeProfile {
  id: string
  email?: string
  name?: string
}

function createCallbackController(profile: FakeProfile): {
  controller: OAuthController
  handleCallback: ReturnType<typeof vi.fn>
} {
  const handleCallback = vi.fn(async () => ({ profile, redirectTo: undefined }))
  const ctx = createControllerContext(
    'http://guren.dev/auth/github/callback?code=abc&state=def',
    {},
    { oauth: { handleCallback } },
  ) as ControllerContext

  const controller = new OAuthController()
  controller.setContext(ctx as unknown as Context)
  Object.assign(controller, {
    auth: {
      session: () => undefined,
      login: vi.fn(async () => {}),
      logout: vi.fn(async () => {}),
    },
  })

  return { controller, handleCallback }
}

describe('OAuthController callback allowlist', () => {
  const originalAllowlist = process.env.BLOG_ADMIN_GITHUB_ID

  beforeEach(() => {
    process.env.BLOG_ADMIN_GITHUB_ID = '12345'
  })

  afterEach(() => {
    if (originalAllowlist === undefined) {
      delete process.env.BLOG_ADMIN_GITHUB_ID
    } else {
      process.env.BLOG_ADMIN_GITHUB_ID = originalAllowlist
    }
    vi.restoreAllMocks()
  })

  it('should reject a non-allowlisted GitHub id with 403 before touching accounts', async () => {
    const { controller } = createCallbackController({ id: '99999', email: 'evil@example.com' })
    const whereSpy = vi.spyOn(User, 'where')

    await expect(controller.callback()).rejects.toMatchObject({ statusCode: 403 })
    expect(whereSpy).not.toHaveBeenCalled()
  })

  it('should create and log in the allowlisted admin', async () => {
    const { controller } = createCallbackController({
      id: '12345',
      email: 'Admin@Example.com',
      name: 'Admin',
    })
    vi.spyOn(User, 'where').mockResolvedValue([])
    const created = { id: 1, name: 'Admin', email: 'admin@example.com', githubId: '12345' }
    const createSpy = vi.fn(async () => created)
    Object.assign(User, { create: createSpy })

    try {
      const response = await controller.callback()

      expect(createSpy).toHaveBeenCalledWith({
        name: 'Admin',
        email: 'admin@example.com',
        githubId: '12345',
      })
      expect(response.status).toBe(302)
      expect(response.headers.get('Location')).toBe('/admin')
      expect((controller as unknown as { auth: { login: ReturnType<typeof vi.fn> } }).auth.login)
        .toHaveBeenCalledWith(created)
    } finally {
      delete (User as unknown as Record<string, unknown>).create
    }
  })

  it('should reject a GitHub account whose email belongs to an existing non-GitHub account', async () => {
    const { controller } = createCallbackController({ id: '12345', email: 'admin@example.com' })
    vi.spyOn(User, 'where')
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 7, email: 'admin@example.com' } as never])

    await expect(controller.callback()).rejects.toMatchObject({
      errors: {
        message: ['An account with this email already exists. Sign in with the method you originally used.'],
      },
    })
  })
})
