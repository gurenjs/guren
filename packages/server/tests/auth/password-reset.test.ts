import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  createPasswordResetToken,
  verifyPasswordResetToken,
  completePasswordReset,
  buildPasswordResetUrl,
  parsePasswordResetUrl,
  MemoryPasswordResetStore,
} from '../../src/auth/password-reset'
import type { UserProvider } from '../../src/auth/types'
import { createMockUser, createMockProvider, type MockUser } from '@guren/testing'

process.env.APP_KEY = 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
delete process.env.APP_PREVIOUS_KEYS

describe('MemoryPasswordResetStore', () => {
  let store: MemoryPasswordResetStore

  beforeEach(() => {
    store = new MemoryPasswordResetStore()
  })

  it('stores and retrieves tokens', async () => {
    const expiresAt = new Date(Date.now() + 60000)
    await store.store('hash123', 'user@example.com', expiresAt)

    const result = await store.find('hash123')

    expect(result).not.toBeNull()
    expect(result?.email).toBe('user@example.com')
    expect(result?.expiresAt).toEqual(expiresAt)
  })

  it('returns null for non-existent tokens', async () => {
    const result = await store.find('nonexistent')
    expect(result).toBeNull()
  })

  it('returns null for expired tokens', async () => {
    const expiresAt = new Date(Date.now() - 1000) // Already expired
    await store.store('expired', 'user@example.com', expiresAt)

    const result = await store.find('expired')
    expect(result).toBeNull()
  })

  it('deletes tokens', async () => {
    const expiresAt = new Date(Date.now() + 60000)
    await store.store('todelete', 'user@example.com', expiresAt)

    await store.delete('todelete')
    const result = await store.find('todelete')

    expect(result).toBeNull()
  })

  it('deletes all tokens for an email', async () => {
    const expiresAt = new Date(Date.now() + 60000)
    await store.store('hash1', 'user@example.com', expiresAt)
    await store.store('hash2', 'user@example.com', expiresAt)
    await store.store('hash3', 'other@example.com', expiresAt)

    await store.deleteForEmail('user@example.com')

    expect(await store.find('hash1')).toBeNull()
    expect(await store.find('hash2')).toBeNull()
    expect(await store.find('hash3')).not.toBeNull()
  })

  it('clears all tokens', () => {
    const expiresAt = new Date(Date.now() + 60000)
    store.store('hash1', 'user1@example.com', expiresAt)
    store.store('hash2', 'user2@example.com', expiresAt)

    store.clear()

    // We can only test this indirectly by trying to find them
    expect(store.find('hash1')).resolves.toBeNull()
    expect(store.find('hash2')).resolves.toBeNull()
  })
})

describe('createPasswordResetToken', () => {
  let store: MemoryPasswordResetStore

  beforeEach(() => {
    store = new MemoryPasswordResetStore()
  })

  it('generates a token and stores its hash', async () => {
    const result = await createPasswordResetToken('user@example.com', store)

    expect(result.token).toBeTruthy()
    expect(result.token.length).toBeGreaterThan(0)
    expect(result.tokenId).toBeTruthy()
    expect(result.tokenId).not.toBe(result.token)
    expect(result.expiresAt).toBeInstanceOf(Date)
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now())
  })

  it('deletes existing tokens for the same email', async () => {
    const result1 = await createPasswordResetToken('user@example.com', store)
    const result2 = await createPasswordResetToken('user@example.com', store)

    // First token should be invalidated
    const found1 = await store.find(result1.tokenId)
    const found2 = await store.find(result2.tokenId)

    expect(found1).toBeNull()
    expect(found2).not.toBeNull()
  })

  it('uses custom expiration time', async () => {
    const expiresIn = 5 * 60 * 1000 // 5 minutes
    const beforeCreate = Date.now()

    const result = await createPasswordResetToken('user@example.com', store, { expiresIn })

    const expectedMinExpiry = beforeCreate + expiresIn
    expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(expectedMinExpiry - 100) // Allow 100ms tolerance
  })
})

describe('verifyPasswordResetToken', () => {
  let store: MemoryPasswordResetStore

  beforeEach(() => {
    store = new MemoryPasswordResetStore()
  })

  it('returns email for valid token', async () => {
    const { token } = await createPasswordResetToken('user@example.com', store)

    const email = await verifyPasswordResetToken(token, store)

    expect(email).toBe('user@example.com')
  })

  it('returns null for invalid token', async () => {
    const email = await verifyPasswordResetToken('invalid-token', store)
    expect(email).toBeNull()
  })

  it('returns null for tampered token', async () => {
    const { token } = await createPasswordResetToken('user@example.com', store)
    const tampered = `${token}x`

    expect(await verifyPasswordResetToken(tampered, store)).toBeNull()
  })

  it('returns null for expired token', async () => {
    const { token } = await createPasswordResetToken('user@example.com', store, {
      expiresIn: -1000, // Already expired
    })

    const email = await verifyPasswordResetToken(token, store)
    expect(email).toBeNull()
  })
})

describe('completePasswordReset', () => {
  let store: MemoryPasswordResetStore
  let users: MockUser[]
  let provider: UserProvider<MockUser>
  let passwordUpdates: Array<{ userId: number; password: string }>

  beforeEach(() => {
    store = new MemoryPasswordResetStore()
    users = [
      createMockUser({ id: 1, email: 'user@example.com', password: 'old-password' }),
    ]
    provider = createMockProvider(users)
    passwordUpdates = []
  })

  const updatePassword = async (user: MockUser, password: string) => {
    passwordUpdates.push({ userId: user.id, password })
    user.password = password
  }

  it('updates password and returns user for valid token', async () => {
    const { token } = await createPasswordResetToken('user@example.com', store)

    const user = await completePasswordReset(token, 'new-password', store, provider, updatePassword)

    expect(user).not.toBeNull()
    expect(user?.id).toBe(1)
    expect(passwordUpdates).toHaveLength(1)
    expect(passwordUpdates[0]).toEqual({ userId: 1, password: 'new-password' })
  })

  it('invalidates token after use', async () => {
    const { token } = await createPasswordResetToken('user@example.com', store)

    await completePasswordReset(token, 'new-password', store, provider, updatePassword)

    // Second attempt with same token should fail
    const email = await verifyPasswordResetToken(token, store)
    expect(email).toBeNull()
  })

  it('returns null for invalid token', async () => {
    const user = await completePasswordReset('invalid', 'new-password', store, provider, updatePassword)

    expect(user).toBeNull()
    expect(passwordUpdates).toHaveLength(0)
  })

  it('returns null if user no longer exists', async () => {
    const { token } = await createPasswordResetToken('user@example.com', store)

    // Remove the user
    users.length = 0

    const user = await completePasswordReset(token, 'new-password', store, provider, updatePassword)

    expect(user).toBeNull()
    expect(passwordUpdates).toHaveLength(0)
  })
})

describe('buildPasswordResetUrl', () => {
  it('builds URL with token', () => {
    const url = buildPasswordResetUrl('https://example.com/reset', 'abc123')
    expect(url).toBe('https://example.com/reset?token=abc123')
  })

  it('builds URL with token and email', () => {
    const url = buildPasswordResetUrl('https://example.com/reset', 'abc123', 'user@example.com')
    expect(url).toBe('https://example.com/reset?token=abc123&email=user%40example.com')
  })

  it('handles base URL with existing query params', () => {
    const url = buildPasswordResetUrl('https://example.com/reset?foo=bar', 'abc123')
    expect(url).toContain('foo=bar')
    expect(url).toContain('token=abc123')
  })
})

describe('parsePasswordResetUrl', () => {
  it('extracts token from URL', () => {
    const { token, email } = parsePasswordResetUrl('https://example.com/reset?token=abc123')

    expect(token).toBe('abc123')
    expect(email).toBeNull()
  })

  it('extracts token and email from URL', () => {
    const { token, email } = parsePasswordResetUrl(
      'https://example.com/reset?token=abc123&email=user%40example.com',
    )

    expect(token).toBe('abc123')
    expect(email).toBe('user@example.com')
  })

  it('returns null for missing token', () => {
    const { token } = parsePasswordResetUrl('https://example.com/reset')
    expect(token).toBeNull()
  })
})
