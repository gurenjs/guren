import { describe, test, expect } from 'bun:test'
import { RequestAuthContext } from '../../src/auth/RequestAuthContext'
import { AuthenticationException } from '../../src/errors/exceptions/AuthenticationException'
import type { Guard, AuthCredentials } from '../../src/auth/types'
import type { Session } from '../../src/http/middleware'

function createMockGuard(overrides: Partial<Guard> = {}): Guard {
  return {
    async check() { return false },
    async guest() { return true },
    async user() { return null },
    async id() { return null },
    async login() {},
    async logout() {},
    async attempt() { return false },
    async validate() { return null },
    session() { return undefined },
    ...overrides,
  } as Guard
}

function createContext(
  guardOverrides: Partial<Guard> = {},
  session?: Session,
) {
  const guard = createMockGuard(guardOverrides)
  const manager = { getDefaultGuard: () => 'web' }
  const resolveGuard = () => guard
  return new RequestAuthContext(manager, {} as any, session, resolveGuard)
}

describe('RequestAuthContext', () => {
  describe('guard', () => {
    test('should return a guard', () => {
      const ctx = createContext()
      expect(ctx.guard()).toBeDefined()
    })

    test('should cache guards by name', () => {
      const ctx = createContext()
      const a = ctx.guard()
      const b = ctx.guard()
      expect(a).toBe(b)
    })
  })

  describe('delegation methods', () => {
    test('check should delegate to guard', async () => {
      const ctx = createContext({ async check() { return true } })
      expect(await ctx.check()).toBe(true)
    })

    test('guest should delegate to guard', async () => {
      const ctx = createContext({ async guest() { return false } })
      expect(await ctx.guest()).toBe(false)
    })

    test('user should delegate to guard', async () => {
      const mockUser = { id: 1, name: 'Test' }
      const ctx = createContext({ user: async () => mockUser as any })
      const result = await ctx.user()
      expect(result).toBe(mockUser as any)
    })

    test('id should delegate to guard', async () => {
      const ctx = createContext({ async id() { return 42 } })
      expect(await ctx.id()).toBe(42)
    })

    test('attempt should delegate to guard', async () => {
      const ctx = createContext({ async attempt() { return true } })
      expect(await ctx.attempt({ email: 'x', password: 'y' })).toBe(true)
    })
  })

  describe('userOrFail', () => {
    test('should return user when authenticated', async () => {
      const mockUser = { id: 1 }
      const ctx = createContext({ user: async () => mockUser as any })
      const result = await ctx.userOrFail()
      expect(result).toBe(mockUser as any)
    })

    test('should throw AuthenticationException when not authenticated', async () => {
      const ctx = createContext()
      await expect(ctx.userOrFail()).rejects.toBeInstanceOf(AuthenticationException)
    })
  })

  describe('session', () => {
    test('should return the session', () => {
      const session = { get: () => {} } as unknown as Session
      const ctx = createContext({}, session)
      expect(ctx.session()).toBe(session)
    })

    test('should return undefined when no session', () => {
      const ctx = createContext()
      expect(ctx.session()).toBeUndefined()
    })
  })
})
