import { describe, test, expect } from 'bun:test'
import { AuthManager } from '../../src/auth/AuthManager'
import type { Guard, GuardContext, UserProvider, AuthCredentials, Authenticatable } from '../../src/auth/types'

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
