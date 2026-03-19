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
} from '../../src/auth/email-verification'

describe('MemoryEmailVerificationStore', () => {
  let store: MemoryEmailVerificationStore

  beforeEach(() => {
    store = new MemoryEmailVerificationStore()
  })

  it('stores and retrieves tokens', async () => {
    const token = {
      email: 'test@example.com',
      hashedToken: 'hashed-token',
      expiresAt: new Date(Date.now() + 3600000),
      createdAt: new Date(),
    }

    await store.store(token)
    const found = await store.findByHashedToken('hashed-token')

    expect(found).toEqual(token)
  })

  it('returns null for non-existent tokens', async () => {
    const found = await store.findByHashedToken('non-existent')
    expect(found).toBeNull()
  })

  it('deletes tokens by hashed token', async () => {
    const token = {
      email: 'test@example.com',
      hashedToken: 'hashed-token',
      expiresAt: new Date(Date.now() + 3600000),
      createdAt: new Date(),
    }

    await store.store(token)
    await store.delete('hashed-token')
    const found = await store.findByHashedToken('hashed-token')

    expect(found).toBeNull()
  })

  it('deletes all tokens for an email', async () => {
    await store.store({
      email: 'user@example.com',
      hashedToken: 'hash1',
      expiresAt: new Date(Date.now() + 3600000),
      createdAt: new Date(),
    })
    await store.store({
      email: 'user@example.com',
      hashedToken: 'hash2',
      expiresAt: new Date(Date.now() + 3600000),
      createdAt: new Date(),
    })
    await store.store({
      email: 'other@example.com',
      hashedToken: 'hash3',
      expiresAt: new Date(Date.now() + 3600000),
      createdAt: new Date(),
    })

    await store.deleteForEmail('user@example.com')

    expect(await store.findByHashedToken('hash1')).toBeNull()
    expect(await store.findByHashedToken('hash2')).toBeNull()
    expect(await store.findByHashedToken('hash3')).not.toBeNull()
  })

  it('clears all tokens', () => {
    store.clear()
    expect(store.size).toBe(0)
  })

  it('reports correct size', async () => {
    expect(store.size).toBe(0)

    await store.store({
      email: 'test@example.com',
      hashedToken: 'hash',
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
    expect(result.token.length).toBe(64) // 32 bytes hex encoded
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

    expect(result.token.length).toBe(32) // 16 bytes hex encoded
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
