import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  createEmailVerificationToken,
  verifyEmailToken,
  completeEmailVerification,
  buildVerificationUrl,
  parseVerificationUrl,
  isEmailVerified,
  requireVerifiedEmail,
  MemoryEmailVerificationStore,
  type EmailVerificationToken,
} from '../../src/auth/email-verification'

process.env.APP_KEY = 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
delete process.env.APP_PREVIOUS_KEYS

describe('MemoryEmailVerificationStore', () => {
  let store: MemoryEmailVerificationStore

  beforeEach(() => {
    store = new MemoryEmailVerificationStore()
  })

  it('stores and retrieves tokens', async () => {
    const token = {
      email: 'test@example.com',
      tokenId: 'token-id',
      expiresAt: new Date(Date.now() + 3600000),
      createdAt: new Date(),
    }

    await store.store(token)
    const found = await store.findByTokenId('token-id')

    expect(found).toEqual(token)
  })

  it('returns null for non-existent tokens', async () => {
    const found = await store.findByTokenId('non-existent')
    expect(found).toBeNull()
  })

  it('deletes tokens by token id', async () => {
    const token = {
      email: 'test@example.com',
      tokenId: 'token-id',
      expiresAt: new Date(Date.now() + 3600000),
      createdAt: new Date(),
    }

    await store.store(token)
    await store.delete('token-id')
    const found = await store.findByTokenId('token-id')

    expect(found).toBeNull()
  })

  it('deletes all tokens for an email', async () => {
    await store.store({
      email: 'user@example.com',
      tokenId: 'hash1',
      expiresAt: new Date(Date.now() + 3600000),
      createdAt: new Date(),
    })
    await store.store({
      email: 'user@example.com',
      tokenId: 'hash2',
      expiresAt: new Date(Date.now() + 3600000),
      createdAt: new Date(),
    })
    await store.store({
      email: 'other@example.com',
      tokenId: 'hash3',
      expiresAt: new Date(Date.now() + 3600000),
      createdAt: new Date(),
    })

    await store.deleteForEmail('user@example.com')

    expect(await store.findByTokenId('hash1')).toBeNull()
    expect(await store.findByTokenId('hash2')).toBeNull()
    expect(await store.findByTokenId('hash3')).not.toBeNull()
  })

  it('clears all tokens', () => {
    store.clear()
    expect(store.size).toBe(0)
  })

  it('reports correct size', async () => {
    expect(store.size).toBe(0)

    await store.store({
      email: 'test@example.com',
      tokenId: 'hash',
      expiresAt: new Date(),
      createdAt: new Date(),
    })

    expect(store.size).toBe(1)
  })
})

describe('createEmailVerificationToken', () => {
  let store: MemoryEmailVerificationStore

  beforeEach(() => {
    store = new MemoryEmailVerificationStore()
  })

  it('creates a token with correct structure', async () => {
    const result = await createEmailVerificationToken('user@example.com', store)

    expect(result.token).toBeDefined()
    expect(result.token.length).toBeGreaterThan(64)
    expect(result.expiresAt).toBeInstanceOf(Date)
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now())
  })

  it('stores the token in the store', async () => {
    await createEmailVerificationToken('user@example.com', store)

    expect(store.size).toBe(1)
  })

  it('deletes existing tokens for the same email', async () => {
    await createEmailVerificationToken('user@example.com', store)
    await createEmailVerificationToken('user@example.com', store)

    expect(store.size).toBe(1)
  })

  it('normalizes email to lowercase', async () => {
    const result = await createEmailVerificationToken('User@Example.COM', store)
    const email = await verifyEmailToken(result.token, store)

    expect(email).toBe('user@example.com')
  })

  it('respects custom expiration time', async () => {
    const oneHour = 60 * 60 * 1000
    const before = Date.now()

    const result = await createEmailVerificationToken('user@example.com', store, {
      expiresIn: oneHour,
    })

    const expectedExpiry = before + oneHour
    expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(expectedExpiry - 100)
    expect(result.expiresAt.getTime()).toBeLessThanOrEqual(expectedExpiry + 100)
  })

  it('respects custom token length', async () => {
    const result = await createEmailVerificationToken('user@example.com', store, {
      tokenLength: 16,
    })

    expect(result.token.length).toBeGreaterThan(32)
  })
})

describe('verifyEmailToken', () => {
  let store: MemoryEmailVerificationStore

  beforeEach(() => {
    store = new MemoryEmailVerificationStore()
  })

  it('returns email for valid token', async () => {
    const { token } = await createEmailVerificationToken('user@example.com', store)
    const email = await verifyEmailToken(token, store)

    expect(email).toBe('user@example.com')
  })

  it('returns null for invalid token', async () => {
    const email = await verifyEmailToken('invalid-token', store)
    expect(email).toBeNull()
  })

  it('returns null for tampered token', async () => {
    const { token } = await createEmailVerificationToken('user@example.com', store)
    expect(await verifyEmailToken(`${token}x`, store)).toBeNull()
  })

  // Rejecting a bad signature must not touch the store. An implementation that
  // read the id out of the payload and deleted it before checking the HMAC
  // would still return null here, so asserting only the null lets an
  // unauthenticated request revoke someone else's live token.
  it('leaves the record intact when the signature does not verify', async () => {
    const { token } = await createEmailVerificationToken('user@example.com', store)

    expect(await verifyEmailToken(`${token}x`, store)).toBeNull()

    expect(store.size).toBe(1)
    expect(await verifyEmailToken(token, store)).toBe('user@example.com')
  })

  it('returns null for expired token', async () => {
    const { token } = await createEmailVerificationToken('user@example.com', store, {
      expiresIn: -1000, // Already expired
    })

    const email = await verifyEmailToken(token, store)
    expect(email).toBeNull()
  })

  it('deletes expired tokens on verification', async () => {
    const { token } = await createEmailVerificationToken('user@example.com', store, {
      expiresIn: -1000,
    })

    await verifyEmailToken(token, store)
    expect(store.size).toBe(0)
  })

  it('does not consume the token', async () => {
    const { token } = await createEmailVerificationToken('user@example.com', store)

    await verifyEmailToken(token, store)
    const email = await verifyEmailToken(token, store)

    expect(email).toBe('user@example.com')
  })
})

describe('completeEmailVerification', () => {
  let store: MemoryEmailVerificationStore

  beforeEach(() => {
    store = new MemoryEmailVerificationStore()
  })

  it('calls markVerified with the correct email', async () => {
    const { token } = await createEmailVerificationToken('user@example.com', store)
    const markVerified = vi.fn().mockResolvedValue({ id: 1, verified: true })

    await completeEmailVerification(token, store, markVerified)

    expect(markVerified).toHaveBeenCalledWith('user@example.com')
  })

  it('returns the result of markVerified', async () => {
    const { token } = await createEmailVerificationToken('user@example.com', store)
    const user = { id: 1, email: 'user@example.com', emailVerifiedAt: new Date() }
    const markVerified = vi.fn().mockResolvedValue(user)

    const result = await completeEmailVerification(token, store, markVerified)

    expect(result).toEqual(user)
  })

  it('returns null for invalid token', async () => {
    const markVerified = vi.fn()
    const result = await completeEmailVerification('invalid', store, markVerified)

    expect(result).toBeNull()
    expect(markVerified).not.toHaveBeenCalled()
  })

  it('returns null for expired token', async () => {
    const { token } = await createEmailVerificationToken('user@example.com', store, {
      expiresIn: -1000,
    })
    const markVerified = vi.fn()

    const result = await completeEmailVerification(token, store, markVerified)

    expect(result).toBeNull()
    expect(markVerified).not.toHaveBeenCalled()
  })

  it('deletes the token after successful verification', async () => {
    const { token } = await createEmailVerificationToken('user@example.com', store)

    await completeEmailVerification(token, store, async () => ({}))

    expect(store.size).toBe(0)
  })

  it('cannot reuse a consumed token', async () => {
    const { token } = await createEmailVerificationToken('user@example.com', store)
    const markVerified = vi.fn().mockResolvedValue({})

    await completeEmailVerification(token, store, markVerified)
    const result = await completeEmailVerification(token, store, markVerified)

    expect(result).toBeNull()
    expect(markVerified).toHaveBeenCalledTimes(1)
  })
})

describe('buildVerificationUrl', () => {
  it('builds URL with token', () => {
    const url = buildVerificationUrl('https://example.com/verify', 'abc123')

    expect(url).toBe('https://example.com/verify?token=abc123')
  })

  it('builds URL with token and email', () => {
    const url = buildVerificationUrl('https://example.com/verify', 'abc123', 'user@example.com')

    expect(url).toBe('https://example.com/verify?token=abc123&email=user%40example.com')
  })

  it('preserves existing query parameters', () => {
    const url = buildVerificationUrl('https://example.com/verify?ref=email', 'abc123')

    expect(url).toContain('ref=email')
    expect(url).toContain('token=abc123')
  })
})

describe('parseVerificationUrl', () => {
  it('extracts token from URL', () => {
    const { token, email } = parseVerificationUrl('https://example.com/verify?token=abc123')

    expect(token).toBe('abc123')
    expect(email).toBeNull()
  })

  it('extracts token and email from URL', () => {
    const { token, email } = parseVerificationUrl(
      'https://example.com/verify?token=abc123&email=user%40example.com'
    )

    expect(token).toBe('abc123')
    expect(email).toBe('user@example.com')
  })

  it('returns null for invalid URLs', () => {
    const { token, email } = parseVerificationUrl('not-a-valid-url')

    expect(token).toBeNull()
    expect(email).toBeNull()
  })

  it('returns null when token is missing', () => {
    const { token } = parseVerificationUrl('https://example.com/verify')

    expect(token).toBeNull()
  })
})

describe('isEmailVerified', () => {
  it('returns true when emailVerifiedAt is set', () => {
    expect(isEmailVerified({ emailVerifiedAt: new Date() })).toBe(true)
  })

  it('returns false when emailVerifiedAt is null', () => {
    expect(isEmailVerified({ emailVerifiedAt: null })).toBe(false)
  })

  it('returns false when emailVerifiedAt is undefined', () => {
    expect(isEmailVerified({ emailVerifiedAt: undefined })).toBe(false)
  })

  it('returns false when user is null', () => {
    expect(isEmailVerified(null)).toBe(false)
  })

  it('returns false when user has no emailVerifiedAt property', () => {
    expect(isEmailVerified({} as { emailVerifiedAt?: Date })).toBe(false)
  })
})

describe('requireVerifiedEmail', () => {
  it('calls next for verified users', async () => {
    const middleware = requireVerifiedEmail({
      getUser: async () => ({ emailVerifiedAt: new Date() }),
    })

    const next = vi.fn()
    const ctx = {
      get: vi.fn(),
      redirect: vi.fn().mockReturnValue(new Response()),
    }

    await middleware(ctx, next)

    expect(next).toHaveBeenCalled()
    expect(ctx.redirect).not.toHaveBeenCalled()
  })

  it('redirects unverified users', async () => {
    const middleware = requireVerifiedEmail({
      getUser: async () => ({ emailVerifiedAt: null }),
    })

    const next = vi.fn()
    const ctx = {
      get: vi.fn(),
      redirect: vi.fn().mockReturnValue(new Response()),
    }

    await middleware(ctx, next)

    expect(next).not.toHaveBeenCalled()
    expect(ctx.redirect).toHaveBeenCalledWith('/verify-email')
  })

  it('uses custom redirect URL', async () => {
    const middleware = requireVerifiedEmail({
      redirectTo: '/please-verify',
      getUser: async () => ({ emailVerifiedAt: null }),
    })

    const ctx = {
      get: vi.fn(),
      redirect: vi.fn().mockReturnValue(new Response()),
    }

    await middleware(ctx, vi.fn())

    expect(ctx.redirect).toHaveBeenCalledWith('/please-verify')
  })

  it('redirects when user is null', async () => {
    const middleware = requireVerifiedEmail({
      getUser: async () => null,
    })

    const ctx = {
      get: vi.fn(),
      redirect: vi.fn().mockReturnValue(new Response()),
    }

    await middleware(ctx, vi.fn())

    expect(ctx.redirect).toHaveBeenCalled()
  })
})

// `MemoryEmailVerificationStore` already hands back whatever it holds, expired
// or not. Subclassed only to reach the stored record, so a test can move its
// `expiresAt` after issuance: the `exp` claim signed into the token is the one
// authority on expiry, and the store's copy is there for the store's own
// housekeeping.
class LenientEmailVerificationStore extends MemoryEmailVerificationStore {
  last: EmailVerificationToken | null = null

  async store(token: EmailVerificationToken): Promise<void> {
    await super.store(token)
    this.last = token
  }

  only(): EmailVerificationToken {
    if (!this.last) throw new Error('store is empty')
    return this.last
  }
}

describe('expiry is decided by the signed token, not the store record', () => {
  let store: LenientEmailVerificationStore

  beforeEach(() => {
    store = new LenientEmailVerificationStore()
  })

  it('accepts an unexpired token whose store record claims to be expired', async () => {
    const { token } = await createEmailVerificationToken('user@example.com', store)
    store.only().expiresAt = new Date(Date.now() - 60_000)

    expect(await verifyEmailToken(token, store)).toBe('user@example.com')
  })

  // The store is what makes a token revocable. A verify that trusted the signed
  // claim alone would report a deleted token as valid.
  it('rejects a live token whose record was revoked', async () => {
    const { token } = await createEmailVerificationToken('user@example.com', store)
    await store.delete(store.only().tokenId)

    expect(await verifyEmailToken(token, store)).toBeNull()
  })

  it('rejects a token whose stored email no longer matches the signed one', async () => {
    const { token } = await createEmailVerificationToken('user@example.com', store)
    store.only().email = 'attacker@example.com'

    expect(await verifyEmailToken(token, store)).toBeNull()
  })

  it('rejects an expired token whose store record claims to be live', async () => {
    const { token } = await createEmailVerificationToken('user@example.com', store, {
      expiresIn: -2000,
    })
    store.only().expiresAt = new Date(Date.now() + 60_000)

    expect(await verifyEmailToken(token, store)).toBeNull()
    expect(store.size).toBe(0)
  })

  it('completeEmailVerification applies the same rule', async () => {
    const markVerified = vi.fn().mockResolvedValue({ verified: true })

    const live = await createEmailVerificationToken('user@example.com', store)
    store.only().expiresAt = new Date(Date.now() - 60_000)
    expect(await completeEmailVerification(live.token, store, markVerified)).toEqual({ verified: true })

    const expired = await createEmailVerificationToken('user@example.com', store, { expiresIn: -2000 })
    store.only().expiresAt = new Date(Date.now() + 60_000)
    expect(await completeEmailVerification(expired.token, store, markVerified)).toBeNull()

    expect(markVerified).toHaveBeenCalledTimes(1)
    expect(store.size).toBe(0)
  })
})
