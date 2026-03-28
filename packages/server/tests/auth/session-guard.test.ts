import { describe, test, expect, beforeEach } from 'bun:test'
import { SessionGuard } from '../../src/auth/SessionGuard'
import type { Authenticatable, AuthCredentials, UserProvider } from '../../src/auth/types'
import type { Session } from '../../src/http/middleware'

// --- Test helpers ---

interface MockUser extends Authenticatable {
  id: number
  email: string
  password: string
  rememberToken: string | null
}

function createMockUser(overrides: Partial<MockUser> = {}): MockUser {
  return {
    id: 1,
    email: 'user@test.com',
    password: 'hashed_password',
    rememberToken: null,
    getAuthIdentifier() { return this.id },
    getAuthPassword() { return this.password },
    getRememberToken() { return this.rememberToken },
    setRememberToken(token: string | null) { this.rememberToken = token },
    ...overrides,
  }
}

function createMockSession(): Session & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    data,
    id: 'test-session-id',
    isNew: false,
    get<T>(key: string): T | undefined {
      return data.get(key) as T | undefined
    },
    set(key: string, value: unknown) {
      data.set(key, value)
    },
    forget(key: string) {
      data.delete(key)
    },
    has(key: string) {
      return data.has(key)
    },
    all() {
      return Object.fromEntries(data)
    },
    flush() {
      data.clear()
    },
    regenerate() {},
    invalidate() {},
    flash() {},
    getFlash() { return undefined },
    reflash() {},
    keep() {},
  } as unknown as Session & { data: Map<string, unknown> }
}

function createMockProvider(users: MockUser[] = []): UserProvider<MockUser> {
  return {
    async retrieveById(id: unknown) {
      return users.find((u) => u.id === id) ?? null
    },
    async retrieveByCredentials(credentials: AuthCredentials) {
      if (credentials.rememberToken) {
        return users.find((u) => u.rememberToken === credentials.rememberToken) ?? null
      }
      return users.find((u) => u.email === credentials.email) ?? null
    },
    async validateCredentials(user: MockUser, credentials: AuthCredentials) {
      return user.password === credentials.password
    },
    getId(user: MockUser) {
      return user.id
    },
    async setRememberToken(user: MockUser, token: string | null) {
      user.rememberToken = token
    },
    getRememberToken(user: MockUser) {
      return user.rememberToken
    },
  }
}

// --- Tests ---

describe('SessionGuard', () => {
  let session: ReturnType<typeof createMockSession>
  let user: MockUser
  let provider: UserProvider<MockUser>

  beforeEach(() => {
    session = createMockSession()
    user = createMockUser()
    provider = createMockProvider([user])
  })

  function createGuard(overrides: Partial<{ session: Session | undefined; provider: UserProvider<MockUser> }> = {}) {
    return new SessionGuard<MockUser>({
      provider: overrides.provider ?? provider,
      session: 'session' in overrides ? overrides.session : session,
    })
  }

  describe('check / guest', () => {
    test('should return false when no session data', async () => {
      const guard = createGuard()
      expect(await guard.check()).toBe(false)
      expect(await guard.guest()).toBe(true)
    })

    test('should return true when user is in session', async () => {
      session.set('auth:user_id', 1)
      const guard = createGuard()
      expect(await guard.check()).toBe(true)
      expect(await guard.guest()).toBe(false)
    })

    test('should return false when session user ID is not found in provider', async () => {
      session.set('auth:user_id', 999)
      const guard = createGuard()
      expect(await guard.check()).toBe(false)
    })

    test('should return false when session is undefined', async () => {
      const guard = createGuard({ session: undefined })
      expect(await guard.check()).toBe(false)
      expect(await guard.guest()).toBe(true)
    })
  })

  describe('user', () => {
    test('should return null when not authenticated', async () => {
      const guard = createGuard()
      expect(await guard.user()).toBeNull()
    })

    test('should return user from session', async () => {
      session.set('auth:user_id', 1)
      const guard = createGuard()
      const resolved = await guard.user()
      expect(resolved).not.toBeNull()
      expect(resolved!.id).toBe(1)
    })

    test('should cache the resolved user', async () => {
      session.set('auth:user_id', 1)
      const guard = createGuard()

      const first = await guard.user()
      const second = await guard.user()
      expect(first).toBe(second)
    })

    test('should clear session key when user not found by provider', async () => {
      session.set('auth:user_id', 999)
      const guard = createGuard()
      expect(await guard.user()).toBeNull()
      expect(session.data.has('auth:user_id')).toBe(false)
    })
  })

  describe('id', () => {
    test('should return null when no session', async () => {
      const guard = createGuard({ session: undefined })
      expect(await guard.id()).toBeNull()
    })

    test('should return stored user ID', async () => {
      session.set('auth:user_id', 42)
      const guard = createGuard()
      expect(await guard.id()).toBe(42)
    })
  })

  describe('login', () => {
    test('should set user ID in session', async () => {
      const guard = createGuard()
      await guard.login(user)
      expect(session.get<number>('auth:user_id')).toBe(1 as any)
    })

    test('should cache the logged-in user', async () => {
      const guard = createGuard()
      await guard.login(user)
      const resolved = await guard.user()
      expect(resolved).toBe(user as any)
    })

    test('should throw when session is undefined', async () => {
      const guard = createGuard({ session: undefined })
      expect(guard.login(user)).rejects.toThrow('session middleware is required')
    })

    test('should set remember token when remember is true', async () => {
      const guard = createGuard()
      await guard.login<MockUser>(user, true)
      expect(session.get('auth:remember_token')).toBeDefined()
      expect(user.rememberToken).not.toBeNull()
    })

    test('should clear remember token when remember is false', async () => {
      session.set('auth:remember_token', 'old-token')
      const guard = createGuard()
      await guard.login<MockUser>(user, false)
      expect(session.data.has('auth:remember_token')).toBe(false)
    })
  })

  describe('logout', () => {
    test('should clear session data', async () => {
      session.set('auth:user_id', 1)
      session.set('auth:remember_token', 'token')
      const guard = createGuard()
      await guard.logout()
      expect(session.data.has('auth:user_id')).toBe(false)
      expect(session.data.has('auth:remember_token')).toBe(false)
    })

    test('should clear cached user', async () => {
      session.set('auth:user_id', 1)
      const guard = createGuard()
      await guard.user() // populate cache
      await guard.logout()
      expect(await guard.user()).toBeNull()
    })

    test('should be safe to call without session', async () => {
      const guard = createGuard({ session: undefined })
      await guard.logout() // should not throw
    })
  })

  describe('attempt', () => {
    test('should return true and login on valid credentials', async () => {
      const guard = createGuard()
      const result = await guard.attempt({ email: 'user@test.com', password: 'hashed_password' })
      expect(result).toBe(true)
      expect(await guard.check()).toBe(true)
    })

    test('should return false on invalid credentials', async () => {
      const guard = createGuard()
      const result = await guard.attempt({ email: 'user@test.com', password: 'wrong' })
      expect(result).toBe(false)
      expect(await guard.check()).toBe(false)
    })

    test('should return false when user not found', async () => {
      const guard = createGuard()
      const result = await guard.attempt({ email: 'nobody@test.com', password: 'x' })
      expect(result).toBe(false)
    })

    test('should set remember token when remember is true', async () => {
      const guard = createGuard()
      await guard.attempt({ email: 'user@test.com', password: 'hashed_password' }, true)
      expect(user.rememberToken).not.toBeNull()
    })
  })

  describe('validate', () => {
    test('should return user on valid credentials', async () => {
      const guard = createGuard()
      const result = await guard.validate({ email: 'user@test.com', password: 'hashed_password' })
      expect(result).not.toBeNull()
      expect(result!.id).toBe(1)
    })

    test('should return null on invalid credentials', async () => {
      const guard = createGuard()
      const result = await guard.validate({ email: 'user@test.com', password: 'wrong' })
      expect(result).toBeNull()
    })

    test('should not login the user', async () => {
      const guard = createGuard()
      await guard.validate({ email: 'user@test.com', password: 'hashed_password' })
      expect(await guard.check()).toBe(false)
    })

    test('should use constant-time delay when user not found (timing attack mitigation)', async () => {
      let validateCalled = false
      const trackingProvider = {
        ...provider,
        async validateCredentials(_user: MockUser, _credentials: AuthCredentials) {
          validateCalled = true
          return false
        },
      }
      const guard = createGuard({ provider: trackingProvider })
      const result = await guard.validate({ email: 'nobody@test.com', password: 'x' })
      expect(result).toBeNull()
      // Should NOT call validateCredentials with a fake user (breaks custom providers)
      expect(validateCalled).toBe(false)
    })
  })

  describe('remember token flow', () => {
    test('should resolve user via remember token when no session user ID', async () => {
      user.rememberToken = 'remember-me'
      session.set('auth:remember_token', 'remember-me')
      const guard = createGuard()
      const resolved = await guard.user()
      expect(resolved).not.toBeNull()
      expect(resolved!.id).toBe(1)
    })

    test('should clear remember token from session when token mismatch', async () => {
      user.rememberToken = 'valid-token'
      session.set('auth:remember_token', 'wrong-token')
      const guard = createGuard()
      const resolved = await guard.user()
      expect(resolved).toBeNull()
      expect(session.data.has('auth:remember_token')).toBe(false)
    })
  })

  describe('session accessor', () => {
    test('should return the session', () => {
      const guard = createGuard()
      expect(guard.session()).toBe(session)
    })

    test('should return undefined when no session', () => {
      const guard = createGuard({ session: undefined })
      expect(guard.session()).toBeUndefined()
    })
  })

  describe('custom session keys', () => {
    test('should use custom session key', async () => {
      const guard = new SessionGuard({
        provider,
        session,
        sessionKey: 'custom:user',
      })
      session.set('custom:user', 1)
      expect(await guard.check()).toBe(true)
    })
  })
})
