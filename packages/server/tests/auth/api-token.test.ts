import { describe, expect, it, beforeEach, vi } from 'vitest'
import { Hono } from 'hono'
import {
  createApiToken,
  parseApiToken,
  verifyApiToken,
  tokenCan,
  tokenCanAll,
  tokenCanAny,
  revokeApiToken,
  revokeAllApiTokens,
  getUserApiTokens,
  createBearerTokenMiddleware,
  getApiToken,
  MemoryApiTokenStore,
  API_TOKEN_KEY,
} from '../../src/auth/api-token'

describe('MemoryApiTokenStore', () => {
  let store: MemoryApiTokenStore

  beforeEach(() => {
    store = new MemoryApiTokenStore()
  })

  it('stores and retrieves tokens by hashed token', async () => {
    const token = {
      id: 'test-id',
      name: 'Test Token',
      hashedToken: 'hashed123',
      userId: 1,
      abilities: ['*'],
      lastUsedAt: null,
      expiresAt: null,
      createdAt: new Date(),
    }

    await store.store(token)
    const found = await store.findByHashedToken('hashed123')

    expect(found).toEqual(token)
  })

  it('returns null for non-existent tokens', async () => {
    const found = await store.findByHashedToken('non-existent')
    expect(found).toBeNull()
  })

  it('finds tokens by user ID', async () => {
    await store.store({
      id: 'token1',
      name: 'Token 1',
      hashedToken: 'hash1',
      userId: 1,
      abilities: ['*'],
      lastUsedAt: null,
      expiresAt: null,
      createdAt: new Date(),
    })
    await store.store({
      id: 'token2',
      name: 'Token 2',
      hashedToken: 'hash2',
      userId: 1,
      abilities: ['*'],
      lastUsedAt: null,
      expiresAt: null,
      createdAt: new Date(),
    })
    await store.store({
      id: 'token3',
      name: 'Token 3',
      hashedToken: 'hash3',
      userId: 2,
      abilities: ['*'],
      lastUsedAt: null,
      expiresAt: null,
      createdAt: new Date(),
    })

    const tokens = await store.findByUserId(1)

    expect(tokens.length).toBe(2)
    expect(tokens.map((t) => t.id)).toContain('token1')
    expect(tokens.map((t) => t.id)).toContain('token2')
  })

  it('deletes tokens by ID', async () => {
    await store.store({
      id: 'token1',
      name: 'Token 1',
      hashedToken: 'hash1',
      userId: 1,
      abilities: ['*'],
      lastUsedAt: null,
      expiresAt: null,
      createdAt: new Date(),
    })

    await store.delete('token1')

    expect(await store.findByHashedToken('hash1')).toBeNull()
  })

  it('deletes all tokens for a user', async () => {
    await store.store({
      id: 'token1',
      name: 'Token 1',
      hashedToken: 'hash1',
      userId: 1,
      abilities: ['*'],
      lastUsedAt: null,
      expiresAt: null,
      createdAt: new Date(),
    })
    await store.store({
      id: 'token2',
      name: 'Token 2',
      hashedToken: 'hash2',
      userId: 1,
      abilities: ['*'],
      lastUsedAt: null,
      expiresAt: null,
      createdAt: new Date(),
    })

    await store.deleteForUser(1)

    expect(await store.findByUserId(1)).toEqual([])
  })

  it('updates last used timestamp', async () => {
    await store.store({
      id: 'token1',
      name: 'Token 1',
      hashedToken: 'hash1',
      userId: 1,
      abilities: ['*'],
      lastUsedAt: null,
      expiresAt: null,
      createdAt: new Date(),
    })

    const timestamp = new Date()
    await store.updateLastUsed('token1', timestamp)

    const token = await store.findByHashedToken('hash1')
    expect(token?.lastUsedAt).toEqual(timestamp)
  })

  it('clears all tokens', async () => {
    await store.store({
      id: 'token1',
      name: 'Token 1',
      hashedToken: 'hash1',
      userId: 1,
      abilities: ['*'],
      lastUsedAt: null,
      expiresAt: null,
      createdAt: new Date(),
    })

    store.clear()

    expect(store.size).toBe(0)
  })
})

describe('createApiToken', () => {
  let store: MemoryApiTokenStore

  beforeEach(() => {
    store = new MemoryApiTokenStore()
  })

  it('creates a token with correct structure', async () => {
    const result = await createApiToken(store, {
      name: 'Test Token',
      userId: 1,
    })

    expect(result.plainTextToken).toMatch(/^[a-f0-9]+\|[a-f0-9]+$/)
    expect(result.token.name).toBe('Test Token')
    expect(result.token.userId).toBe(1)
    expect(result.token.abilities).toEqual(['*'])
    expect(result.token.expiresAt).toBeNull()
  })

  it('stores the token in the store', async () => {
    await createApiToken(store, {
      name: 'Test Token',
      userId: 1,
    })

    expect(store.size).toBe(1)
  })

  it('uses custom abilities', async () => {
    const result = await createApiToken(store, {
      name: 'Test Token',
      userId: 1,
      abilities: ['read', 'write'],
    })

    expect(result.token.abilities).toEqual(['read', 'write'])
  })

  it('sets expiration when expiresIn is provided', async () => {
    const before = Date.now()
    const result = await createApiToken(store, {
      name: 'Test Token',
      userId: 1,
      expiresIn: 3600000, // 1 hour
    })

    expect(result.token.expiresAt).not.toBeNull()
    expect(result.token.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 3600000 - 100)
  })

  it('sets expiration when expiresIn is zero', async () => {
    const before = Date.now()
    const result = await createApiToken(store, {
      name: 'Test Token',
      userId: 1,
      expiresIn: 0,
    })
    const after = Date.now()

    expect(result.token.expiresAt).not.toBeNull()
    expect(result.token.expiresAt!.getTime()).toBeGreaterThanOrEqual(before)
    expect(result.token.expiresAt!.getTime()).toBeLessThanOrEqual(after)
  })
})

describe('parseApiToken', () => {
  it('parses valid token', () => {
    const result = parseApiToken('abc123|def456')

    expect(result).toEqual({ id: 'abc123', token: 'def456' })
  })

  it('returns null for invalid format', () => {
    expect(parseApiToken('invalid')).toBeNull()
    expect(parseApiToken('|')).toBeNull()
    expect(parseApiToken('abc|')).toBeNull()
    expect(parseApiToken('|def')).toBeNull()
  })
})

describe('verifyApiToken', () => {
  let store: MemoryApiTokenStore

  beforeEach(() => {
    store = new MemoryApiTokenStore()
  })

  it('verifies a valid token', async () => {
    const { plainTextToken } = await createApiToken(store, {
      name: 'Test Token',
      userId: 1,
      abilities: ['read'],
    })

    const result = await verifyApiToken(plainTextToken, store)

    expect(result).not.toBeNull()
    expect(result!.userId).toBe(1)
    expect(result!.abilities).toEqual(['read'])
  })

  it('returns null for invalid token', async () => {
    const result = await verifyApiToken('invalid|token', store)
    expect(result).toBeNull()
  })

  it('returns null for expired token', async () => {
    const { plainTextToken } = await createApiToken(store, {
      name: 'Test Token',
      userId: 1,
      expiresIn: -1000, // Already expired
    })

    const result = await verifyApiToken(plainTextToken, store)
    expect(result).toBeNull()
  })

  it('updates lastUsedAt by default', async () => {
    const { plainTextToken, token } = await createApiToken(store, {
      name: 'Test Token',
      userId: 1,
    })

    expect(token.lastUsedAt).toBeNull()

    await verifyApiToken(plainTextToken, store)

    const updated = await store.findByHashedToken(token.hashedToken)
    expect(updated?.lastUsedAt).not.toBeNull()
  })

  it('does not update lastUsedAt when disabled', async () => {
    const { plainTextToken, token } = await createApiToken(store, {
      name: 'Test Token',
      userId: 1,
    })

    await verifyApiToken(plainTextToken, store, { updateLastUsed: false })

    const updated = await store.findByHashedToken(token.hashedToken)
    expect(updated?.lastUsedAt).toBeNull()
  })
})

describe('tokenCan', () => {
  it('returns true for wildcard ability', () => {
    expect(tokenCan({ abilities: ['*'] }, 'anything')).toBe(true)
  })

  it('returns true for matching ability', () => {
    expect(tokenCan({ abilities: ['read', 'write'] }, 'read')).toBe(true)
  })

  it('returns false for non-matching ability', () => {
    expect(tokenCan({ abilities: ['read'] }, 'write')).toBe(false)
  })
})

describe('tokenCanAll', () => {
  it('returns true for wildcard', () => {
    expect(tokenCanAll({ abilities: ['*'] }, ['read', 'write'])).toBe(true)
  })

  it('returns true when all abilities match', () => {
    expect(tokenCanAll({ abilities: ['read', 'write', 'delete'] }, ['read', 'write'])).toBe(true)
  })

  it('returns false when some abilities missing', () => {
    expect(tokenCanAll({ abilities: ['read'] }, ['read', 'write'])).toBe(false)
  })
})

describe('tokenCanAny', () => {
  it('returns true for wildcard', () => {
    expect(tokenCanAny({ abilities: ['*'] }, ['read', 'write'])).toBe(true)
  })

  it('returns true when any ability matches', () => {
    expect(tokenCanAny({ abilities: ['read'] }, ['read', 'write'])).toBe(true)
  })

  it('returns false when no abilities match', () => {
    expect(tokenCanAny({ abilities: ['delete'] }, ['read', 'write'])).toBe(false)
  })
})

describe('revokeApiToken', () => {
  let store: MemoryApiTokenStore

  beforeEach(() => {
    store = new MemoryApiTokenStore()
  })

  it('deletes the token', async () => {
    const { token } = await createApiToken(store, {
      name: 'Test Token',
      userId: 1,
    })

    await revokeApiToken(token.id, store)

    expect(store.size).toBe(0)
  })
})

describe('revokeAllApiTokens', () => {
  let store: MemoryApiTokenStore

  beforeEach(() => {
    store = new MemoryApiTokenStore()
  })

  it('deletes all tokens for a user', async () => {
    await createApiToken(store, { name: 'Token 1', userId: 1 })
    await createApiToken(store, { name: 'Token 2', userId: 1 })
    await createApiToken(store, { name: 'Token 3', userId: 2 })

    await revokeAllApiTokens(1, store)

    expect(await getUserApiTokens(1, store)).toEqual([])
    expect((await getUserApiTokens(2, store)).length).toBe(1)
  })
})

describe('getUserApiTokens', () => {
  let store: MemoryApiTokenStore

  beforeEach(() => {
    store = new MemoryApiTokenStore()
  })

  it('returns all tokens for a user', async () => {
    await createApiToken(store, { name: 'Token 1', userId: 1 })
    await createApiToken(store, { name: 'Token 2', userId: 1 })

    const tokens = await getUserApiTokens(1, store)

    expect(tokens.length).toBe(2)
  })
})

describe('createBearerTokenMiddleware', () => {
  let store: MemoryApiTokenStore
  let app: Hono

  beforeEach(() => {
    store = new MemoryApiTokenStore()
    app = new Hono()
  })

  it('authenticates valid token', async () => {
    const { plainTextToken } = await createApiToken(store, {
      name: 'Test Token',
      userId: 1,
    })

    app.use('*', createBearerTokenMiddleware({ store }))
    app.get('/', (c) => c.text('OK'))

    const res = await app.request('/', {
      headers: { Authorization: `Bearer ${plainTextToken}` },
    })

    expect(res.status).toBe(200)
  })

  it('rejects missing authorization header', async () => {
    app.use('*', createBearerTokenMiddleware({ store }))
    app.get('/', (c) => c.text('OK'))

    const res = await app.request('/')

    expect(res.status).toBe(401)
  })

  it('rejects invalid authorization format', async () => {
    app.use('*', createBearerTokenMiddleware({ store }))
    app.get('/', (c) => c.text('OK'))

    const res = await app.request('/', {
      headers: { Authorization: 'Basic abc123' },
    })

    expect(res.status).toBe(401)
  })

  it('rejects invalid token', async () => {
    app.use('*', createBearerTokenMiddleware({ store }))
    app.get('/', (c) => c.text('OK'))

    const res = await app.request('/', {
      headers: { Authorization: 'Bearer invalid|token' },
    })

    expect(res.status).toBe(401)
  })

  it('rejects expired token', async () => {
    const { plainTextToken } = await createApiToken(store, {
      name: 'Test Token',
      userId: 1,
      expiresIn: -1000,
    })

    app.use('*', createBearerTokenMiddleware({ store }))
    app.get('/', (c) => c.text('OK'))

    const res = await app.request('/', {
      headers: { Authorization: `Bearer ${plainTextToken}` },
    })

    expect(res.status).toBe(401)
  })

  it('checks required abilities', async () => {
    const { plainTextToken } = await createApiToken(store, {
      name: 'Test Token',
      userId: 1,
      abilities: ['read'],
    })

    app.use('*', createBearerTokenMiddleware({ store, abilities: ['write'] }))
    app.get('/', (c) => c.text('OK'))

    const res = await app.request('/', {
      headers: { Authorization: `Bearer ${plainTextToken}` },
    })

    expect(res.status).toBe(403)
  })

  it('allows wildcard ability', async () => {
    const { plainTextToken } = await createApiToken(store, {
      name: 'Test Token',
      userId: 1,
      abilities: ['*'],
    })

    app.use('*', createBearerTokenMiddleware({ store, abilities: ['any', 'thing'] }))
    app.get('/', (c) => c.text('OK'))

    const res = await app.request('/', {
      headers: { Authorization: `Bearer ${plainTextToken}` },
    })

    expect(res.status).toBe(200)
  })

  it('sets token in context', async () => {
    const { plainTextToken } = await createApiToken(store, {
      name: 'Test Token',
      userId: 1,
    })

    app.use('*', createBearerTokenMiddleware({ store }))
    app.get('/', (c) => {
      const tokenInfo = getApiToken(c)
      return c.json({ userId: tokenInfo?.userId })
    })

    const res = await app.request('/', {
      headers: { Authorization: `Bearer ${plainTextToken}` },
    })
    const body = await res.json()

    expect(body.userId).toBe(1)
  })

  it('loads user when loadUser provided', async () => {
    const { plainTextToken } = await createApiToken(store, {
      name: 'Test Token',
      userId: 1,
    })

    const loadUser = vi.fn().mockResolvedValue({ id: 1, name: 'John' })

    app.use('*', createBearerTokenMiddleware({ store, loadUser }))
    app.get('/', (c) => {
      const user = (c as unknown as { get: (key: string) => unknown }).get('guren:user') as { name: string }
      return c.json({ name: user.name })
    })

    const res = await app.request('/', {
      headers: { Authorization: `Bearer ${plainTextToken}` },
    })
    const body = await res.json()

    expect(loadUser).toHaveBeenCalledWith(1)
    expect(body.name).toBe('John')
  })

  it('uses custom unauthorized handler', async () => {
    app.use(
      '*',
      createBearerTokenMiddleware({
        store,
        onUnauthorized: (ctx) => ctx.json({ custom: true }, 401),
      })
    )
    app.get('/', (c) => c.text('OK'))

    const res = await app.request('/')
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(body.custom).toBe(true)
  })

  it('uses custom forbidden handler', async () => {
    const { plainTextToken } = await createApiToken(store, {
      name: 'Test Token',
      userId: 1,
      abilities: ['read'],
    })

    app.use(
      '*',
      createBearerTokenMiddleware({
        store,
        abilities: ['write'],
        onForbidden: (ctx, required) =>
          ctx.json({ forbidden: true, required }, 403),
      })
    )
    app.get('/', (c) => c.text('OK'))

    const res = await app.request('/', {
      headers: { Authorization: `Bearer ${plainTextToken}` },
    })
    const body = await res.json()

    expect(res.status).toBe(403)
    expect(body.forbidden).toBe(true)
    expect(body.required).toEqual(['write'])
  })
})
