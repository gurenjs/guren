import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  createControllerContext,
  createControllerModuleMock,
} from '@guren/testing/controller'
import type { Context } from '@guren/core'

const { mockGetUserApiTokens, mockRevokeApiToken } = vi.hoisted(() => ({
  mockGetUserApiTokens: vi.fn(),
  mockRevokeApiToken: vi.fn(),
}))

vi.mock('@guren/core', async () => {
  const actual = await vi.importActual<typeof import('@guren/core')>('@guren/core')
  return {
    ...actual,
    ...createControllerModuleMock(),
    getUserApiTokens: mockGetUserApiTokens,
    revokeApiToken: mockRevokeApiToken,
  }
})

import TokenController from '../app/Http/Controllers/TokenController.js'

function createController(ctx: Context): TokenController {
  const controller = new TokenController()
  controller.setContext(ctx)
  return controller
}

function authenticatedContext(
  url: string,
  init: RequestInit = {},
  caller: { abilities?: string[]; expiresAt?: Date } = {},
): Context {
  const { abilities = ['*'], expiresAt } = caller
  return createControllerContext(url, init, {
    'guren:api-token': { userId: 1, abilities, token: expiresAt ? { abilities, expiresAt } : {} },
  }) as unknown as Context
}

describe('TokenController', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('index()', () => {
    it('throws when unauthenticated', async () => {
      const ctx = createControllerContext('http://api.test/api/auth/tokens', {
        method: 'GET',
      }) as unknown as Context

      const controller = createController(ctx)

      await expect(controller.index()).rejects.toMatchObject({
        statusCode: 401,
      })
    })

    it('returns user tokens when authenticated', async () => {
      const tokens = [{
        id: 'tok-1',
        name: 'Test Token',
        abilities: ['*'],
        lastUsedAt: null,
        expiresAt: null,
        createdAt: new Date('2026-01-01'),
      }]
      mockGetUserApiTokens.mockResolvedValue(tokens)

      const ctx = authenticatedContext('http://api.test/api/auth/tokens', {
        method: 'GET',
      })

      const controller = createController(ctx)
      const response = await controller.index()

      expect(response.status).toBe(200)
      const json = await response.json()
      expect(json.tokens).toHaveLength(1)
      expect(json.tokens[0].name).toBe('Test Token')
    })
  })

  describe('store()', () => {
    it('creates a new token', async () => {
      const ctx = authenticatedContext('http://api.test/api/auth/tokens', {
        method: 'POST',
        body: JSON.stringify({
          name: 'My Token',
          abilities: ['tasks:read'],
        }),
        headers: { 'Content-Type': 'application/json' },
      })

      const controller = createController(ctx)
      const response = await controller.store()

      expect(response.status).toBe(201)
      const json = await response.json()
      expect(json.token).toBeDefined()
      expect(json.tokenId).toBeDefined()
    })

    it('refuses a caller whose token does not grant *', async () => {
      const ctx = authenticatedContext('http://api.test/api/auth/tokens', {
        method: 'POST',
        body: JSON.stringify({ name: 'Escalated' }),
        headers: { 'Content-Type': 'application/json' },
      }, { abilities: ['tasks:read', 'tokens:manage'] })

      const controller = createController(ctx)
      const response = await controller.store()

      expect(response.status).toBe(403)
      const json = await response.json()
      expect(json.token).toBeUndefined()
    })

    it('caps the new token at the caller token expiry', async () => {
      const callerExpiresAt = new Date(Date.now() + 60 * 60 * 1000)
      const request = (body: Record<string, unknown>) => authenticatedContext('http://api.test/api/auth/tokens', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
      }, { expiresAt: callerExpiresAt })

      for (const body of [{ name: 'Longer', expiresInDays: 30 }, { name: 'Unbounded' }]) {
        const response = await createController(request(body)).store()

        expect(response.status).toBe(201)
        const json = await response.json()
        expect(json.expiresAt).not.toBeNull()
        // createApiToken reads the clock again after the controller does, so allow that gap.
        expect(new Date(json.expiresAt).getTime()).toBeLessThanOrEqual(callerExpiresAt.getTime() + 1000)
      }
    })

    it('throws validation errors for missing name', async () => {
      const ctx = authenticatedContext('http://api.test/api/auth/tokens', {
        method: 'POST',
        body: JSON.stringify({}),
        headers: { 'Content-Type': 'application/json' },
      })

      const controller = createController(ctx)

      await expect(controller.store()).rejects.toMatchObject({
        statusCode: 422,
      })
    })
  })

  describe('destroy()', () => {
    it('revokes a token belonging to user', async () => {
      mockGetUserApiTokens.mockResolvedValue([
        { id: 'tok-1', name: 'Token', abilities: ['*'], createdAt: new Date(), lastUsedAt: null, expiresAt: null },
      ])
      mockRevokeApiToken.mockResolvedValue(undefined)

      const ctx = authenticatedContext('http://api.test/api/auth/tokens/tok-1', {
        method: 'DELETE',
      })
      ;(ctx.req as { param: (key?: string) => unknown }).param = vi.fn((key?: string) => {
        if (!key) return { id: 'tok-1' }
        return key === 'id' ? 'tok-1' : undefined
      })

      const controller = createController(ctx)
      const response = await controller.destroy()

      expect(response.status).toBe(200)
      const json = await response.json()
      expect(json.message).toBe('Token revoked')
    })

    it('returns 404 for token not belonging to user', async () => {
      mockGetUserApiTokens.mockResolvedValue([])

      const ctx = authenticatedContext('http://api.test/api/auth/tokens/tok-999', {
        method: 'DELETE',
      })
      ;(ctx.req as { param: (key?: string) => unknown }).param = vi.fn((key?: string) => {
        if (!key) return { id: 'tok-999' }
        return key === 'id' ? 'tok-999' : undefined
      })

      const controller = createController(ctx)
      const response = await controller.destroy()

      expect(response.status).toBe(404)
    })
  })
})
