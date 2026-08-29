import { describe, test, expect } from 'bun:test'
import { AuthManager } from '../../src/auth/AuthManager'
import type { Guard, GuardContext, UserProvider, AuthCredentials, Authenticatable } from '../../src/auth/types'
import { createApiToken, MemoryApiTokenStore } from '../../src/auth/api-token'
import { TokenGuard } from '../../src/auth/TokenGuard'
import { fakeContext } from '../support/fake-context'

// --- Test helpers ---

function createMockGuardFactory(): (ctx: GuardContext) => Guard {
  return () => ({
    async check() { return false },
    async guest() { return true },
    async user() { return null },
    async id() { return null },
    async login() {},
    async logout() {},
    async attempt() { return false },
    async validate() { return null },
    session() { return undefined },
  })
}

function createMockProviderFactory(): (manager: any) => UserProvider {
  return () => ({
    async retrieveById() { return null },
    async retrieveByCredentials() { return null },
    async validateCredentials() { return false },
    getId() { return null },
  })
}

// --- Tests ---

describe('AuthManager', () => {
  describe('constructor', () => {
    test('should default to "web" guard', () => {
      const manager = new AuthManager()
      expect(manager.getDefaultGuard()).toBe('web')
    })

    test('should accept custom default guard', () => {
      const manager = new AuthManager({ defaultGuard: 'api' })
      expect(manager.getDefaultGuard()).toBe('api')
    })
  })

  describe('registerGuard / createGuard', () => {
    test('should register and create a guard', () => {
      const manager = new AuthManager()
      const factory = createMockGuardFactory()
      manager.registerGuard('web', factory)

      const guard = manager.createGuard('web', {} as GuardContext)
      expect(guard).toBeDefined()
    })

    test('should throw for unregistered guard', () => {
      const manager = new AuthManager()
      expect(() => manager.createGuard('unknown', {} as GuardContext))
        .toThrow('guard "unknown" has not been registered')
    })
  })

  describe('registerProvider / getProvider', () => {
    test('should register and retrieve a provider', () => {
      const manager = new AuthManager()
      manager.registerProvider('users', createMockProviderFactory())

      const provider = manager.getProvider('users')
      expect(provider).toBeDefined()
    })

    test('should throw for unregistered provider', () => {
      const manager = new AuthManager()
      expect(() => manager.getProvider('unknown'))
        .toThrow('provider "unknown" has not been registered')
    })

    test('should return the same provider instance (singleton)', () => {
      const manager = new AuthManager()
      manager.registerProvider('users', createMockProviderFactory())

      const a = manager.getProvider('users')
      const b = manager.getProvider('users')
      expect(a).toBe(b)
    })
  })

  describe('guardNames', () => {
    test('should return registered guard names', () => {
      const manager = new AuthManager()
      manager.registerGuard('web', createMockGuardFactory())
      manager.registerGuard('api', createMockGuardFactory())

      expect(manager.guardNames()).toEqual(['web', 'api'])
    })

    test('should return empty array when no guards registered', () => {
      const manager = new AuthManager()
      expect(manager.guardNames()).toEqual([])
    })
  })

  describe('setDefaultGuard', () => {
    test('should set the default guard', () => {
      const manager = new AuthManager()
      manager.registerGuard('web', createMockGuardFactory())
      manager.registerGuard('api', createMockGuardFactory())
      manager.setDefaultGuard('api')
      expect(manager.getDefaultGuard()).toBe('api')
    })

    test('should throw for unregistered guard', () => {
      const manager = new AuthManager()
      expect(() => manager.setDefaultGuard('unknown'))
        .toThrow('cannot set default guard to unregistered guard "unknown"')
    })
  })
})

describe('ModelUserProvider.sanitize', () => {
  test('strips the password column, remember token, and model hidden fields', async () => {
    const { ModelUserProvider } = await import('../../src/auth/providers/ModelUserProvider')

    class FakeUserModel {
      static hidden = ['apiSecret']
    }

    const provider = new ModelUserProvider(FakeUserModel as never, {
      passwordColumn: 'passwordHash',
      rememberTokenColumn: 'rememberToken',
    })

    const clean = provider.sanitize({
      id: 1,
      email: 'a@x.com',
      passwordHash: 'scrypt:...',
      rememberToken: 'tok',
      apiSecret: 's3cret',
      name: 'A',
    } as never) as unknown as Record<string, unknown>

    expect(clean).toEqual({ id: 1, email: 'a@x.com', name: 'A' })
  })
})

// --- RFC 0016: token guard selection ---

describe('AuthManager.useTokens', () => {
  function createManagerWithSessionAndTokens(store: MemoryApiTokenStore) {
    const manager = new AuthManager()
    const sessionGuard: Guard = {
      ...createMockGuardFactory()({} as GuardContext),
      check: async () => true,
      guest: async () => false,
      user: (async () => ({ id: 'session-user' })) as Guard['user'],
      id: async () => 'session-user',
    }
    manager.registerGuard('web', () => sessionGuard)
    manager.setDefaultGuard('web')
    manager.useTokens(store)
    return { manager, sessionGuard }
  }

  test('resolveGuardName should pick the token guard only for Bearer requests', () => {
    const { manager } = createManagerWithSessionAndTokens(new MemoryApiTokenStore())

    expect(manager.resolveGuardName(fakeContext() as never)).toBe('web')
    expect(manager.resolveGuardName(fakeContext({ headers: { Authorization: 'Bearer abc' } }) as never)).toBe('token')
    expect(manager.resolveGuardName(fakeContext({ headers: { Authorization: 'Basic abc' } }) as never)).toBe('web')
    // Explicit names always win over header selection.
    expect(manager.resolveGuardName(fakeContext({ headers: { Authorization: 'Bearer abc' } }) as never, 'web')).toBe('web')
  })

  test('auth context should authenticate a Bearer request through the token guard', async () => {
    const store = new MemoryApiTokenStore()
    const { manager } = createManagerWithSessionAndTokens(store)
    const { plainTextToken } = await createApiToken(store, { name: 't', userId: 7 })

    const auth = manager.createAuthContext(fakeContext({ headers: { Authorization: `Bearer ${plainTextToken}` } }) as never)

    expect(await auth.check()).toBe(true)
    expect(await auth.user<{ id: number }>()).toEqual({ id: 7 })
    expect(auth.guard()).toBeInstanceOf(TokenGuard)
  })

  test('auth context should keep using the session guard without a Bearer header', async () => {
    const { manager, sessionGuard } = createManagerWithSessionAndTokens(new MemoryApiTokenStore())

    const auth = manager.createAuthContext(fakeContext() as never)

    expect(auth.guard()).toBe(sessionGuard)
    expect(await auth.user<{ id: string }>()).toEqual({ id: 'session-user' })
  })

  test('explicit guard("web") should not share the cache entry with the token-selected default', async () => {
    const store = new MemoryApiTokenStore()
    const { manager, sessionGuard } = createManagerWithSessionAndTokens(store)
    const { plainTextToken } = await createApiToken(store, { name: 't', userId: 7 })

    const auth = manager.createAuthContext(fakeContext({ headers: { Authorization: `Bearer ${plainTextToken}` } }) as never)

    expect(auth.guard()).toBeInstanceOf(TokenGuard)
    expect(auth.guard('web')).toBe(sessionGuard)
    // The implicit guard stays the token guard after the explicit lookup.
    expect(auth.guard()).toBeInstanceOf(TokenGuard)
  })

  test('should resolve the full user through a registered provider', async () => {
    const store = new MemoryApiTokenStore()
    const manager = new AuthManager()
    manager.registerGuard('web', createMockGuardFactory())
    manager.setDefaultGuard('web')
    manager.registerProvider('users', () => ({
      async retrieveById(id: unknown) { return { id, name: 'Alice' } as never },
      async retrieveByCredentials() { return null },
      async validateCredentials() { return false },
      getId(user: { id: unknown }) { return user.id },
    }) as never)
    manager.useTokens(store, { provider: 'users' })

    const { plainTextToken } = await createApiToken(store, { name: 't', userId: 42 })
    const auth = manager.createAuthContext(fakeContext({ headers: { Authorization: `Bearer ${plainTextToken}` } }) as never)

    expect(await auth.user<{ id: number; name: string }>()).toEqual({ id: 42, name: 'Alice' })
  })
})

describe('AuthManager.useTokens guard name collision', () => {
  test('should refuse to shadow an already registered guard', () => {
    const manager = new AuthManager()
    manager.registerGuard('web', createMockGuardFactory())
    manager.setDefaultGuard('web')

    expect(() => manager.useTokens(new MemoryApiTokenStore(), { guardName: 'web' }))
      .toThrow('guard "web" is already registered')
  })

  test('should allow re-calling useTokens with the same guard name', () => {
    const manager = new AuthManager()
    manager.useTokens(new MemoryApiTokenStore())
    expect(() => manager.useTokens(new MemoryApiTokenStore())).not.toThrow()
  })
})
