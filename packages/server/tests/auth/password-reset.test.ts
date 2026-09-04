import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  createPasswordResetToken,
  verifyPasswordResetToken,
  completePasswordReset,
  buildPasswordResetUrl,
  parsePasswordResetUrl,
  MemoryPasswordResetStore,
} from '../../src/auth/password-reset'
import type { PasswordResetTokenStore } from '../../src/auth/password-reset'
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
    const expiresAt = new Date(Date.now() - 1000)
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

    expect(store.find('hash1')).resolves.toBeNull()
    expect(store.find('hash2')).resolves.toBeNull()
  })
})

describe('createPasswordResetToken', () => {
  let store: MemoryPasswordResetStore

  beforeEach(() => {
    store = new MemoryPasswordResetStore()
  })

  it('generates a token and stores its id', async () => {
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

    const found1 = await store.find(result1.tokenId)
    const found2 = await store.find(result2.tokenId)

    expect(found1).toBeNull()
    expect(found2).not.toBeNull()
  })

  it('uses custom expiration time', async () => {
    const expiresIn = 5 * 60 * 1000
    const beforeCreate = Date.now()

    const result = await createPasswordResetToken('user@example.com', store, { expiresIn })

    const expectedMinExpiry = beforeCreate + expiresIn
    expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(expectedMinExpiry - 100)
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
      expiresIn: -1000,
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

// A store that hands back whatever it holds, expired or not, and lets a test
// move a record's `expiresAt` after issuance. Verification must not care: the
// `exp` claim signed into the token is the one authority on expiry, and the
// store's copy is there for the store's own housekeeping.
class LenientPasswordResetStore implements PasswordResetTokenStore {
  readonly records = new Map<string, { email: string; expiresAt: Date }>()

  async store(tokenId: string, email: string, expiresAt: Date): Promise<void> {
    this.records.set(tokenId, { email, expiresAt })
  }

  async find(tokenId: string): Promise<{ email: string; expiresAt: Date } | null> {
    return this.records.get(tokenId) ?? null
  }

  async delete(tokenId: string): Promise<void> {
    this.records.delete(tokenId)
  }

  async deleteForEmail(email: string): Promise<void> {
    for (const [tokenId, record] of this.records) {
      if (record.email === email) this.records.delete(tokenId)
    }
  }
}

describe('expiry is decided by the signed token, not the store record', () => {
  let store: LenientPasswordResetStore
  let provider: UserProvider<MockUser>
  let passwordUpdates: string[]

  beforeEach(() => {
    store = new LenientPasswordResetStore()
    provider = createMockProvider([
      createMockUser({ id: 1, email: 'user@example.com', password: 'old-password' }),
    ])
    passwordUpdates = []
  })

  const updatePassword = async (_user: MockUser, password: string) => {
    passwordUpdates.push(password)
  }

  it('accepts an unexpired token whose store record claims to be expired', async () => {
    const { token, tokenId } = await createPasswordResetToken('user@example.com', store)
    store.records.get(tokenId)!.expiresAt = new Date(Date.now() - 60_000)

    expect(await verifyPasswordResetToken(token, store)).toBe('user@example.com')
  })

  it('rejects an expired token whose store record claims to be live', async () => {
    const { token, tokenId } = await createPasswordResetToken('user@example.com', store, {
      expiresIn: -2000,
    })
    store.records.get(tokenId)!.expiresAt = new Date(Date.now() + 60_000)

    expect(await verifyPasswordResetToken(token, store)).toBeNull()
    expect(store.records.has(tokenId)).toBe(false)
  })

  it('completePasswordReset applies the same rule', async () => {
    const live = await createPasswordResetToken('user@example.com', store)
    store.records.get(live.tokenId)!.expiresAt = new Date(Date.now() - 60_000)

    const user = await completePasswordReset(live.token, 'new-password', store, provider, updatePassword)
    expect(user?.id).toBe(1)
    expect(passwordUpdates).toEqual(['new-password'])

    const expired = await createPasswordResetToken('user@example.com', store, { expiresIn: -2000 })
    store.records.get(expired.tokenId)!.expiresAt = new Date(Date.now() + 60_000)

    expect(
      await completePasswordReset(expired.token, 'another', store, provider, updatePassword),
    ).toBeNull()
    expect(passwordUpdates).toEqual(['new-password'])
    expect(store.records.has(expired.tokenId)).toBe(false)
  })
})
