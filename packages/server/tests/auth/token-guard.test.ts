import { describe, test, expect } from 'bun:test'
import { TokenGuard } from '../../src/auth/TokenGuard'
import {
  API_TOKEN_KEY,
  createApiToken,
  MemoryApiTokenStore,
  type VerifiedApiToken,
} from '../../src/auth/api-token'
import type { UserProvider } from '../../src/auth/types'

import { fakeContext } from '../support/fake-context'

async function issueToken(
  store: MemoryApiTokenStore,
  options: { userId?: string | number; abilities?: string[]; expiresIn?: number | null } = {},
) {
  return createApiToken(store, {
    name: 'test-token',
    userId: options.userId ?? 42,
    abilities: options.abilities,
    expiresIn: options.expiresIn,
  })
}

describe('TokenGuard', () => {
  test('should authenticate a request with a valid bearer token', async () => {
    const store = new MemoryApiTokenStore()
    const { plainTextToken } = await issueToken(store)
    const ctx = fakeContext({ headers: { Authorization: `Bearer ${plainTextToken}` } })

    const guard = new TokenGuard({ store, ctx })

    expect(await guard.check()).toBe(true)
    expect(await guard.guest()).toBe(false)
    expect(await guard.id()).toBe(42)
  })

  test('should resolve a minimal { id } user without a provider', async () => {
    const store = new MemoryApiTokenStore()
    const { plainTextToken } = await issueToken(store, { userId: 'user-7' })
    const ctx = fakeContext({ headers: { Authorization: `Bearer ${plainTextToken}` } })

    const guard = new TokenGuard({ store, ctx })

    expect(await guard.user<{ id: string }>()).toEqual({ id: 'user-7' })
  })

  test('should expose the verification result via API_TOKEN_KEY on the context', async () => {
    const store = new MemoryApiTokenStore()
    const { plainTextToken, token } = await issueToken(store, { abilities: ['posts.store'] })
    const ctx = fakeContext({ headers: { Authorization: `Bearer ${plainTextToken}` } })

    const guard = new TokenGuard({ store, ctx })
    await guard.check()

    const stored = ctx.get(API_TOKEN_KEY) as VerifiedApiToken
    expect(stored.token.id).toBe(token.id)
    expect(stored.abilities).toEqual(['posts.store'])
  })

  test('should treat a request without an Authorization header as a guest', async () => {
    const guard = new TokenGuard({ store: new MemoryApiTokenStore(), ctx: fakeContext() })

    expect(await guard.check()).toBe(false)
    expect(await guard.user()).toBeNull()
    expect(await guard.id()).toBeNull()
  })

  test('should reject an unknown token', async () => {
    const store = new MemoryApiTokenStore()
    await issueToken(store)
    const ctx = fakeContext({ headers: { Authorization: 'Bearer 0123|not-a-real-token' } })

    const guard = new TokenGuard({ store, ctx })
    expect(await guard.check()).toBe(false)
  })

  test('should reject an expired token', async () => {
    const store = new MemoryApiTokenStore()
    const { plainTextToken } = await issueToken(store, { expiresIn: -1_000 })
    const ctx = fakeContext({ headers: { Authorization: `Bearer ${plainTextToken}` } })

    const guard = new TokenGuard({ store, ctx })
    expect(await guard.check()).toBe(false)
  })

  test('should load and sanitize the user through a provider', async () => {
    const store = new MemoryApiTokenStore()
    const { plainTextToken } = await issueToken(store, { userId: 42 })
    const ctx = fakeContext({ headers: { Authorization: `Bearer ${plainTextToken}` } })

    const provider: UserProvider<{ id: number; name: string; passwordHash?: string }> = {
      retrieveById: async (id) => ({ id: Number(id), name: 'Alice', passwordHash: 'secret' }),
      retrieveByCredentials: async () => null,
      validateCredentials: async () => false,
      getId: (user) => user.id,
      sanitize: ({ passwordHash: _stripped, ...rest }) => rest,
    }

    const guard = new TokenGuard({ store, ctx, provider })

    expect(await guard.user<{ id: number; name: string }>()).toEqual({ id: 42, name: 'Alice' })
  })

  test('should return null when the provider cannot find the user', async () => {
    const store = new MemoryApiTokenStore()
    const { plainTextToken } = await issueToken(store)
    const ctx = fakeContext({ headers: { Authorization: `Bearer ${plainTextToken}` } })

    const provider: UserProvider<{ id: number }> = {
      retrieveById: async () => null,
      retrieveByCredentials: async () => null,
      validateCredentials: async () => false,
      getId: (user) => user.id,
    }

    const guard = new TokenGuard({ store, ctx, provider })
    expect(await guard.user()).toBeNull()
    // An unrevoked token whose user no longer exists must NOT count as
    // authenticated when a provider is configured.
    expect(await guard.check()).toBe(false)
  })

  test('should verify the token only once across concurrent calls', async () => {
    const store = new MemoryApiTokenStore()
    const { plainTextToken } = await issueToken(store)
    let lookups = 0
    const countingStore: typeof store = Object.assign(Object.create(Object.getPrototypeOf(store)), store)
    const originalFind = store.findByHashedToken.bind(store)
    countingStore.findByHashedToken = async (hash: string) => {
      lookups += 1
      return originalFind(hash)
    }
    const ctx = fakeContext({ headers: { Authorization: `Bearer ${plainTextToken}` } })

    const guard = new TokenGuard({ store: countingStore, ctx })
    await Promise.all([guard.check(), guard.user(), guard.id()])

    expect(lookups).toBe(1)
  })

  test('should reuse a verification already on the context instead of re-verifying', async () => {
    const store = new MemoryApiTokenStore()
    const { plainTextToken } = await issueToken(store)
    let lookups = 0
    const countingStore: typeof store = Object.assign(Object.create(Object.getPrototypeOf(store)), store)
    const originalFind = store.findByHashedToken.bind(store)
    countingStore.findByHashedToken = async (hash: string) => {
      lookups += 1
      return originalFind(hash)
    }
    const ctx = fakeContext({ headers: { Authorization: `Bearer ${plainTextToken}` } })

    const first = new TokenGuard({ store: countingStore, ctx })
    expect(await first.check()).toBe(true)
    expect(lookups).toBe(1)

    // A second guard on the same request (middleware + guard both mounted)
    // reuses the context result: no second store read, no second lastUsedAt write.
    const second = new TokenGuard({ store: countingStore, ctx })
    expect(await second.check()).toBe(true)
    expect(lookups).toBe(1)
  })

  test('logout should revoke the presented token', async () => {
    const store = new MemoryApiTokenStore()
    const { plainTextToken, token } = await issueToken(store)
    const ctx = fakeContext({ headers: { Authorization: `Bearer ${plainTextToken}` } })

    const guard = new TokenGuard({ store, ctx })
    expect(await guard.check()).toBe(true)

    await guard.logout()

    expect(await guard.check()).toBe(false)
    expect(await store.findByHashedToken(token.hashedToken)).toBeNull()
    // The request-scoped verification result is cleared too — getApiToken()
    // must not succeed after logout on the same request.
    expect(ctx.get(API_TOKEN_KEY)).toBeUndefined()

    // A fresh guard (new request) must also reject the revoked token.
    const nextGuard = new TokenGuard({ store, ctx: fakeContext({ headers: { Authorization: `Bearer ${plainTextToken}` } }) })
    expect(await nextGuard.check()).toBe(false)
  })

  test('should throw for credential-based flows', async () => {
    const guard = new TokenGuard({ store: new MemoryApiTokenStore(), ctx: fakeContext() })

    expect(guard.login()).rejects.toThrow('does not support login')
    expect(guard.attempt({})).rejects.toThrow('does not support attempt')
    expect(guard.validate({})).rejects.toThrow('does not support validate')
  })

  test('session should be undefined', async () => {
    const guard = new TokenGuard({ store: new MemoryApiTokenStore(), ctx: fakeContext() })
    expect(guard.session()).toBeUndefined()
  })
})
