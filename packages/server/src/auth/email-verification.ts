import { getAuthContext } from './context'
import { generateId, buildTokenUrl, parseTokenUrl } from './utils'
import { MessageSigner } from '../encryption/MessageSigner'
import { deriveAppKeyring, getAppKeyringFromEnv } from '../encryption/app-key'

/**
 * Email verification token data stored in the backing store. Only the opaque
 * token ID is stored, never the signed token itself.
 */
export interface EmailVerificationToken {
  email: string
  tokenId: string
  expiresAt: Date
  createdAt: Date
}

/** Store interface for email verification tokens. */
export interface EmailVerificationTokenStore {
  /** Store a new verification token. */
  store(token: EmailVerificationToken): Promise<void>

  /** Find a token by its opaque token ID. */
  findByTokenId(tokenId: string): Promise<EmailVerificationToken | null>

  /** Delete a token by its opaque token ID. */
  delete(tokenId: string): Promise<void>

  /** Delete all tokens for a given email. */
  deleteForEmail(email: string): Promise<void>
}

/** In-memory store for testing. Tokens are lost on restart. */
export class MemoryEmailVerificationStore implements EmailVerificationTokenStore {
  private tokens: Map<string, EmailVerificationToken> = new Map()

  async store(token: EmailVerificationToken): Promise<void> {
    this.tokens.set(token.tokenId, token)
  }

  async findByTokenId(tokenId: string): Promise<EmailVerificationToken | null> {
    return this.tokens.get(tokenId) ?? null
  }

  async delete(tokenId: string): Promise<void> {
    this.tokens.delete(tokenId)
  }

  async deleteForEmail(email: string): Promise<void> {
    const normalizedEmail = email.toLowerCase()
    for (const [key, token] of this.tokens.entries()) {
      if (token.email.toLowerCase() === normalizedEmail) {
        this.tokens.delete(key)
      }
    }
  }

  /** Clear all tokens (useful for testing). */
  clear(): void {
    this.tokens.clear()
  }

  /** Count of stored tokens (useful for testing). */
  get size(): number {
    return this.tokens.size
  }
}

/** Configuration options for email verification. */
export interface EmailVerificationConfig {
  /**
   * Token expiration time in milliseconds.
   * @default 86400000 (24 hours)
   */
  expiresIn?: number

  /**
   * Token byte length (before hex encoding).
   * @default 32
   */
  tokenLength?: number
}

const DEFAULT_CONFIG: Required<EmailVerificationConfig> = {
  expiresIn: 24 * 60 * 60 * 1000, // 24 hours
  tokenLength: 32,
}
const EMAIL_VERIFICATION_PURPOSE = 'email-verification'

function createEmailVerificationSigner(): MessageSigner {
  return new MessageSigner(deriveAppKeyring(getAppKeyringFromEnv(), 'email-verification-signing'))
}

/** Result of creating an email verification token. */
export interface EmailVerificationTokenResult {
  /**
   * The raw token to send to the user via email. Not stored — only its opaque
   * token ID is.
   */
  token: string

  /** When the token expires. */
  expiresAt: Date
}

/**
 * Create a new email verification token; the raw token is returned to send by
 * email and is never stored.
 */
export async function createEmailVerificationToken(
  email: string,
  store: EmailVerificationTokenStore,
  config: EmailVerificationConfig = {}
): Promise<EmailVerificationTokenResult> {
  const { expiresIn, tokenLength } = { ...DEFAULT_CONFIG, ...config }

  await store.deleteForEmail(email)

  const tokenId = generateId()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + expiresIn)
  const signer = createEmailVerificationSigner()
  const token = signer.sign(
    {
      id: tokenId,
      email: email.toLowerCase(),
      bytes: tokenLength,
    },
    {
      purpose: EMAIL_VERIFICATION_PURPOSE,
      expiresIn,
    },
  )

  await store.store({
    email: email.toLowerCase(),
    tokenId,
    expiresAt,
    createdAt: now,
  })

  return { token, expiresAt }
}

/**
 * Verify an email verification token, returning the email address it was
 * issued for or `null` when it is invalid or expired.
 */
export async function verifyEmailToken(
  token: string,
  store: EmailVerificationTokenStore,
  _config: EmailVerificationConfig = {}
): Promise<string | null> {
  const signer = createEmailVerificationSigner()
  const payload = signer.verify<{ id?: string; email?: string }>(token, {
    purpose: EMAIL_VERIFICATION_PURPOSE,
    allowExpired: true,
  })
  if (!payload?.id || !payload.email) {
    return null
  }

  if (typeof payload.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000)) {
    await store.delete(payload.id)
    return null
  }

  const storedToken = await store.findByTokenId(payload.id)

  if (!storedToken) {
    return null
  }

  if (new Date() > storedToken.expiresAt) {
    await store.delete(payload.id)
    return null
  }

  return storedToken.email.toLowerCase() === payload.email.toLowerCase()
    ? storedToken.email
    : null
}

/**
 * Complete email verification by consuming the token. Returns the result of
 * `markVerified`, or `null` when the token is invalid.
 */
export async function completeEmailVerification<T>(
  token: string,
  store: EmailVerificationTokenStore,
  markVerified: (email: string) => Promise<T>
): Promise<T | null> {
  const signer = createEmailVerificationSigner()
  const payload = signer.verify<{ id?: string; email?: string }>(token, {
    purpose: EMAIL_VERIFICATION_PURPOSE,
    allowExpired: true,
  })
  if (!payload?.id || !payload.email) {
    return null
  }

  if (typeof payload.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000)) {
    await store.delete(payload.id)
    return null
  }

  const storedToken = await store.findByTokenId(payload.id)

  if (!storedToken) {
    return null
  }

  if (new Date() > storedToken.expiresAt) {
    await store.delete(payload.id)
    return null
  }

  // Cross-check the two independently-authenticated sources: the signer
  // vouched for payload.email, the store holds storedToken.email of its own.
  if (storedToken.email.toLowerCase() !== payload.email.toLowerCase()) {
    return null
  }

  const result = await markVerified(storedToken.email)

  await store.delete(payload.id)

  return result
}

/** Build a verification URL. */
export const buildVerificationUrl = buildTokenUrl

/** Parse a verification URL to extract token and email. */
export const parseVerificationUrl = parseTokenUrl

/** Whether a user's `emailVerifiedAt` is set. */
export function isEmailVerified(user: { emailVerifiedAt?: Date | null } | null): boolean {
  return user?.emailVerifiedAt != null
}

/**
 * Middleware factory to require verified email.
 *
 * @example
 * ```ts
 * requireVerifiedEmail({ redirectTo: '/verify-email' })
 * ```
 */
export function requireVerifiedEmail(options: {
  redirectTo?: string
  // `get` mirrors Hono's own context idiom: the type argument is inferred from
  // the expected return, so `return ctx.get('user')` type-checks without a cast.
  getUser?: (ctx: { get: <T = unknown>(key: string) => T }) => Promise<{ emailVerifiedAt?: Date | null } | null>
} = {}) {
  const { redirectTo = '/verify-email' } = options

  return async (ctx: { get: <T = unknown>(key: string) => T; redirect: (url: string) => Response }, next: () => Promise<void>) => {
    const getUser = options.getUser ?? (async (c: { get: <T = unknown>(key: string) => T }) => {
      const auth = getAuthContext(c)
      return (await auth?.user<{ emailVerifiedAt?: Date | null }>()) ?? null
    })

    const user = await getUser(ctx)

    if (!isEmailVerified(user)) {
      return ctx.redirect(redirectTo)
    }

    await next()
  }
}
