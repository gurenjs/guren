import { describe, test, expect, beforeEach } from 'bun:test'
import { SessionGuard } from '../../src/auth/SessionGuard'
import type { Authenticatable, AuthCredentials, UserProvider } from '../../src/auth/types'
import type { Session } from '../../src/http/middleware'

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

function createMockSession(): Session & { data: Map<string, unknown>; regenerated: boolean } {
  const data = new Map<string, unknown>()
  const state = { regenerated: false }
  return {
    data,
    get regenerated() {
      return state.regenerated
    },
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
    regenerate() {
      state.regenerated = true
    },
    invalidate() {},
    flash() {},
    getFlash() { return undefined },
    reflash() {},
    keep() {},
  } as unknown as Session & { data: Map<string, unknown>; regenerated: boolean }
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
      await expect(guard.login(user)).rejects.toThrow('session middleware is required')
    })

    test('should regenerate the session ID to prevent session fixation', async () => {
      const guard = createGuard()
      await guard.login(user)
      expect(session.regenerated).toBe(true)
    })

    test('should set remember token when remember is true', async () => {
      const guard = createGuard()
      await guard.login<MockUser>(user, true)
      expect(session.get('auth:remember_token')).toBeDefined()
      expect(user.rememberToken).not.toBeNull()
    })

    test('should generate remember token with 256 bits of entropy', async () => {
      const guard = createGuard()
      await guard.login<MockUser>(user, true)
      expect(user.rememberToken).toMatch(/^[0-9a-f]{64}$/)
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
      await guard.user()
      await guard.logout()
      expect(await guard.user()).toBeNull()
    })

    test('should be safe to call without session', async () => {
      const guard = createGuard({ session: undefined })
      await guard.logout()
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

describe('provider sanitize', () => {
  function createSanitizingProvider(users: MockUser[]): UserProvider<MockUser> {
    const base = createMockProvider(users)
    return {
      ...base,
      sanitize(user: MockUser) {
        const { password: _password, rememberToken: _token, ...clean } = user
        return clean as unknown as MockUser
      },
    }
  }

  test('user() resolved from the session never exposes sanitized fields', async () => {
    const user = createMockUser()
    const session = createMockSession()
    const guard = new SessionGuard({ provider: createSanitizingProvider([user]), session })

    session.set('auth:user_id', 1)

    const resolved = await guard.user<Record<string, unknown>>()
    expect(resolved?.id).toBe(1)
    expect(resolved).not.toHaveProperty('password')
    expect(resolved).not.toHaveProperty('rememberToken')
  })

  test('user() after login() is sanitized while credentials still validate', async () => {
    const user = createMockUser()
    const session = createMockSession()
    const guard = new SessionGuard({ provider: createSanitizingProvider([user]), session })

    const ok = await guard.attempt({ email: 'user@test.com', password: 'hashed_password' })
    expect(ok).toBe(true)

    const resolved = await guard.user<Record<string, unknown>>()
    expect(resolved?.email).toBe('user@test.com')
    expect(resolved).not.toHaveProperty('password')
  })

  test('providers without sanitize keep returning the record as-is', async () => {
    const user = createMockUser()
    const session = createMockSession()
    const guard = new SessionGuard({ provider: createMockProvider([user]), session })

    session.set('auth:user_id', 1)
    const resolved = await guard.user<Record<string, unknown>>()
    expect(resolved).toHaveProperty('password')
  })
})

describe('ModelUserProvider passwordless accounts', () => {
  test('rejects password login for an account without a password hash', async () => {
    const { ModelUserProvider } = await import('../../src/auth/providers/ModelUserProvider')

    const passwordlessUser = { id: 1, email: 'oauth@guren.dev', passwordHash: null }
    const fakeModel = {
      async find() {
        return passwordlessUser
      },
      async where() {
        return [passwordlessUser]
      },
    }

    let dummyHashes = 0
    const provider = new ModelUserProvider(fakeModel as never, {
      passwordColumn: 'passwordHash',
      hasher: {
        async hash(value: string) {
          dummyHashes += 1
          return `hashed:${value}`
        },
        async verify() {
          throw new Error('verify must not run against a missing hash')
        },
      },
    })

    const valid = await provider.validateCredentials(passwordlessUser as never, {
      email: 'oauth@guren.dev',
      password: 'anything',
    })

    expect(valid).toBe(false)
    // The timing-equalization dummy hash ran instead of verify.
    expect(dummyHashes).toBe(1)
  })
})

describe('credential fingerprint', () => {
  const FINGERPRINT_KEY = 'auth:user_id:fingerprint'

  let session: ReturnType<typeof createMockSession>
  let user: MockUser
  let lookups: number

  /** The stored record is `user`; the fingerprint follows its `password`, as a model provider's follows the hash. */
  function fingerprintingProvider(users: MockUser[] = [user]): UserProvider<MockUser> {
    const base = createMockProvider(users)
    return {
      ...base,
      async retrieveById(id: unknown) {
        lookups += 1
        return base.retrieveById(id)
      },
      credentialFingerprint(record: MockUser) {
        const password = (record as Partial<MockUser>).password
        if (password === undefined) return undefined
        return password === '' ? null : `fp:${password}`
      },
    }
  }

  function createGuard(options: Partial<{ sessionKey: string }> = {}) {
    return new SessionGuard<MockUser>({ provider: fingerprintingProvider(), session, ...options })
  }

  beforeEach(() => {
    session = createMockSession()
    user = createMockUser()
    lookups = 0
  })

  test('should store the fingerprint at login', async () => {
    await createGuard().login(user)

    expect(session.data.get(FINGERPRINT_KEY)).toBe('fp:hashed_password')
  })

  test('should keep resolving the user while the credential is unchanged', async () => {
    await createGuard().login(user)

    const next = createGuard()
    expect(await next.check()).toBe(true)
    expect(await next.id()).toBe(1)
  })

  test('should end the session once the credential changes', async () => {
    await createGuard().login(user, true)
    user.password = 'new_hashed_password'

    const next = createGuard()
    expect(await next.user()).toBeNull()
    expect(await next.check()).toBe(false)
    expect(await next.id()).toBeNull()
    expect(session.data.has('auth:user_id')).toBe(false)
    expect(session.data.has('auth:remember_token')).toBe(false)
    expect(session.data.has(FINGERPRINT_KEY)).toBe(false)
  })

  test('should report no id for an ended session without a prior user() call', async () => {
    await createGuard().login(user)
    user.password = 'new_hashed_password'

    expect(await createGuard().id()).toBeNull()
  })

  test('should keep the session that logs in again after the change', async () => {
    await createGuard().login(user)
    user.password = 'new_hashed_password'
    await createGuard().login(user)

    expect(await createGuard().check()).toBe(true)
    expect(session.data.get(FINGERPRINT_KEY)).toBe('fp:new_hashed_password')
  })

  test('should end a session that carries no fingerprint', async () => {
    session.set('auth:user_id', 1)

    const guard = createGuard()
    expect(await guard.check()).toBe(false)
    expect(session.data.has('auth:user_id')).toBe(false)
  })

  test('should read the stored record when login() is given a sanitized one', async () => {
    const { password: _password, ...sanitized } = user

    await createGuard().login(sanitized as MockUser)

    expect(lookups).toBe(1)
    expect(session.data.get(FINGERPRINT_KEY)).toBe('fp:hashed_password')
    expect(await createGuard().check()).toBe(true)
  })

  test('should not look the user up again when login() is given the full record', async () => {
    await createGuard().login(user)

    expect(lookups).toBe(0)
  })

  test('should accept an account with no credential and end its session once it gains one', async () => {
    user.password = ''
    await createGuard().login(user)
    expect(session.data.has(FINGERPRINT_KEY)).toBe(false)
    expect(await createGuard().check()).toBe(true)

    user.password = 'hashed_password'
    expect(await createGuard().check()).toBe(false)
  })

  test('should end a remembered session opened under a previous credential', async () => {
    user.rememberToken = 'remember-me'
    session.set('auth:remember_token', 'remember-me')
    session.set(FINGERPRINT_KEY, 'fp:old_hashed_password')

    expect(await createGuard().user()).toBeNull()
    expect(session.data.has('auth:remember_token')).toBe(false)
    expect(session.data.has(FINGERPRINT_KEY)).toBe(false)
  })

  test('should resolve a remembered session opened under the current credential', async () => {
    user.rememberToken = 'remember-me'
    session.set('auth:remember_token', 'remember-me')
    session.set(FINGERPRINT_KEY, 'fp:hashed_password')

    expect((await createGuard().user())?.id).toBe(1)
  })

  test('should end a bound session whose stored record carries no credential', async () => {
    await createGuard().login(user)
    delete (user as Partial<MockUser>).password

    expect(await createGuard().check()).toBe(false)
  })

  test('should move the session to the new hash when validate() rehashes its own user', async () => {
    const provider = fingerprintingProvider()
    provider.rehashPasswordIfRequired = async (record) => {
      record.password = 'rehashed_password'
    }
    await new SessionGuard<MockUser>({ provider, session }).login(user)

    const confirming = new SessionGuard<MockUser>({ provider, session })
    expect(await confirming.validate({ email: user.email, password: 'hashed_password' })).not.toBeNull()

    expect(session.data.get(FINGERPRINT_KEY)).toBe('fp:rehashed_password')
    expect(await createGuard().check()).toBe(true)
  })

  test('should move a remembered session to the new hash when validate() rehashes its user', async () => {
    user.rememberToken = 'remember-me'
    session.set('auth:remember_token', 'remember-me')
    session.set(FINGERPRINT_KEY, 'fp:hashed_password')
    const provider = fingerprintingProvider()
    provider.rehashPasswordIfRequired = async (record) => {
      record.password = 'rehashed_password'
    }

    const confirming = new SessionGuard<MockUser>({ provider, session })
    expect(await confirming.validate({ email: user.email, password: 'hashed_password' })).not.toBeNull()

    expect(session.data.get(FINGERPRINT_KEY)).toBe('fp:rehashed_password')
    expect((await createGuard().user())?.id).toBe(1)
  })

  test('should leave the session alone when validate() rehashes another user', async () => {
    const other = createMockUser({ id: 2, email: 'other@test.com', password: 'other_hash' })
    const provider = fingerprintingProvider([user, other])
    provider.rehashPasswordIfRequired = async (record) => {
      record.password = `rehashed_${record.password}`
    }
    await new SessionGuard<MockUser>({ provider, session }).login(user)

    const confirming = new SessionGuard<MockUser>({ provider, session })
    expect(await confirming.validate({ email: 'other@test.com', password: 'other_hash' })).not.toBeNull()

    expect(session.data.get(FINGERPRINT_KEY)).toBe('fp:hashed_password')
    expect(await createGuard().check()).toBe(true)
  })

  test('should clear the fingerprint at logout', async () => {
    const guard = createGuard()
    await guard.login(user)
    await guard.logout()

    expect(session.data.has(FINGERPRINT_KEY)).toBe(false)
  })

  test('should derive the fingerprint key from a custom session key', async () => {
    await createGuard({ sessionKey: 'admin:user' }).login(user)

    expect(session.data.get('admin:user:fingerprint')).toBe('fp:hashed_password')
    expect(session.data.has(FINGERPRINT_KEY)).toBe(false)
    expect(await createGuard({ sessionKey: 'admin:user' }).check()).toBe(true)
  })

  test('should leave a provider without the capability unbound', async () => {
    const guard = new SessionGuard<MockUser>({ provider: createMockProvider([user]), session })
    await guard.login(user)
    user.password = 'new_hashed_password'

    expect(session.data.has(FINGERPRINT_KEY)).toBe(false)
    expect(await new SessionGuard<MockUser>({ provider: createMockProvider([user]), session }).check()).toBe(true)
  })
})

describe('ModelUserProvider credentialFingerprint', () => {
  async function providerFor() {
    const { ModelUserProvider } = await import('../../src/auth/providers/ModelUserProvider')
    return new ModelUserProvider({} as never, { passwordColumn: 'passwordHash' })
  }

  test('should return a digest that does not contain the hash', async () => {
    const provider = await providerFor()
    const hash = '$scrypt$n=16384,r=8,p=1$c2FsdA$ZGVyaXZlZA'

    const fingerprint = provider.credentialFingerprint({ id: 1, passwordHash: hash } as never)

    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(fingerprint).not.toContain(hash)
  })

  test('should change when the hash changes', async () => {
    const provider = await providerFor()

    const before = provider.credentialFingerprint({ id: 1, passwordHash: 'hash-a' } as never)
    const after = provider.credentialFingerprint({ id: 1, passwordHash: 'hash-b' } as never)

    expect(before).not.toBe(after)
  })

  test('should return null for an account without a password hash', async () => {
    const provider = await providerFor()

    expect(provider.credentialFingerprint({ id: 1, passwordHash: null } as never)).toBeNull()
    expect(provider.credentialFingerprint({ id: 1, passwordHash: '' } as never)).toBeNull()
  })

  test('should return undefined for a record that does not carry the column', async () => {
    const provider = await providerFor()

    expect(provider.credentialFingerprint({ id: 1 } as never)).toBeUndefined()
  })
})
