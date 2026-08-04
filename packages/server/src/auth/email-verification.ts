import { generateId, buildTokenUrl, parseTokenUrl } from './utils'
import { MessageSigner } from '../encryption/MessageSigner'
import { deriveAppKeyring, getAppKeyringFromEnv } from '../encryption/app-key'

/**
 * Email verification token data stored in the backing store.
 * Only the hashed token is stored for security.
 */
export interface EmailVerificationToken {
  email: string
  tokenId: string
  expiresAt: Date
  createdAt: Date
}

/**
 * Store interface for email verification tokens.
 * Implement this to use database-backed storage.
 */
export interface EmailVerificationTokenStore {
  /**
   * Store a new verification token.
   */
  store(token: EmailVerificationToken): Promise<void>

  /**
   * Find a token by its opaque token ID.
   */
  findByTokenId(tokenId: string): Promise<EmailVerificationToken | null>

  /**
   * Delete a token by its opaque token ID.
   */
  delete(tokenId: string): Promise<void>

  /**
   * Delete all tokens for a given email.
   */
  deleteForEmail(email: string): Promise<void>
}

/**
 * In-memory store for testing purposes.
 * Do NOT use in production - tokens will be lost on restart.
 */
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

  /**
   * Clear all tokens (useful for testing).
   */
  clear(): void {
    this.tokens.clear()
  }

  /**
   * Get the count of stored tokens (useful for testing).
   */
  get size(): number {
    return this.tokens.size
  }
}

/**
 * Configuration options for email verification.
 */
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

/**
 * Result of creating an email verification token.
 */
export interface EmailVerificationTokenResult {
  /**
   * The raw token to send to the user via email.
   * This is NOT stored - only the hash is stored.
   */
  token: string

  /**
   * When the token expires.
   */
  expiresAt: Date
}

/**
 * Create a new email verification token.
 *
 * @param email - The email address to verify
 * @param store - Token store implementation
 * @param config - Optional configuration
 * @returns The raw token to send via email
 *
 * @example
 * ```ts
 * const { token, expiresAt } = await createEmailVerificationToken(
 *   user.email,
 *   verificationStore
 * )
 *
 * // Send email with verification link
 * await sendEmail({
 *   to: user.email,
 *   subject: 'Verify your email',
 *   html: `<a href="${buildVerificationUrl(baseUrl, token)}">Verify Email</a>`,
 * })
 * ```
 */
export async function createEmailVerificationToken(
  email: string,
  store: EmailVerificationTokenStore,
  config: EmailVerificationConfig = {}
): Promise<EmailVerificationTokenResult> {
  const { expiresIn, tokenLength } = { ...DEFAULT_CONFIG, ...config }

  // Delete any existing tokens for this email
  await store.deleteForEmail(email)

  // Generate a secure random token
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
 * Verify an email verification token.
 *
 * @param token - The raw token from the verification link
 * @param store - Token store implementation
 * @param config - Optional configuration (not currently used, reserved for future)
 * @returns The email address if valid, null if invalid or expired
 *
 * @example
 * ```ts
 * const email = await verifyEmailToken(token, verificationStore)
 *
 * if (!email) {
 *   return ctx.json({ error: 'Invalid or expired token' }, 400)
 * }
 *
 * // Mark user as verified
 * await User.update({ email }, { emailVerifiedAt: new Date() })
 * ```
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

  // Check if expired
  if (new Date() > storedToken.expiresAt) {
    await store.delete(payload.id)
    return null
  }

  return storedToken.email.toLowerCase() === payload.email.toLowerCase()
    ? storedToken.email
    : null
}

/**
 * Complete email verification by consuming the token.
 *
 * @param token - The raw token from the verification link
 * @param store - Token store implementation
 * @param markVerified - Function to mark the user as verified
 * @returns The result of markVerified if successful, null if token invalid
 *
 * @example
 * ```ts
 * const result = await completeEmailVerification(
 *   token,
 *   verificationStore,
 *   async (email) => {
 *     await User.update({ email }, { emailVerifiedAt: new Date() })
 *     return User.findByEmail(email)
 *   }
 * )
 *
 * if (!result) {
 *   return ctx.json({ error: 'Invalid or expired token' }, 400)
 * }
 *
 * return ctx.redirect('/dashboard')
 * ```
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

  // Check if expired
  if (new Date() > storedToken.expiresAt) {
    await store.delete(payload.id)
    return null
  }

  // Verify email matches between JWT and store
  if (storedToken.email.toLowerCase() !== payload.email.toLowerCase()) {
    return null
  }

  // Mark as verified
  const result = await markVerified(storedToken.email)

  // Delete the used token
  await store.delete(payload.id)

  return result
}

/**
 * Build a verification URL.
 */
export const buildVerificationUrl = buildTokenUrl

/**
 * Parse a verification URL to extract token and email.
 */
export const parseVerificationUrl = parseTokenUrl

/**
 * Check if a user's email is verified.
 * Helper function for use with User models.
 *
 * @param user - User object with emailVerifiedAt field
 * @returns true if verified, false otherwise
 *
 * @example
 * ```ts
 * if (!isEmailVerified(user)) {
 *   return ctx.redirect('/verify-email')
 * }
 * ```
 */
export function isEmailVerified(user: { emailVerifiedAt?: Date | null } | null): boolean {
  return user?.emailVerifiedAt != null
}

/**
 * Middleware factory to require verified email.
 *
 * @param options - Configuration options
 * @returns Middleware function
 *
 * @example
 * ```ts
 * router.get('/dashboard', [DashboardController, 'index'],
 *   requireAuthenticated(),
 *   requireVerifiedEmail({ redirectTo: '/verify-email' })
 * )
 * ```
 */
export function requireVerifiedEmail(options: {
  redirectTo?: string
  getUser?: (ctx: { get: (key: string) => unknown }) => Promise<{ emailVerifiedAt?: Date | null } | null>
} = {}) {
  const { redirectTo = '/verify-email' } = options

  return async (ctx: { get: (key: string) => unknown; redirect: (url: string) => Response }, next: () => Promise<void>) => {
    const getUser = options.getUser ?? (async (c: { get: (key: string) => unknown }) => {
      const auth = c.get('guren:auth') as { user?: () => Promise<{ emailVerifiedAt?: Date | null } | null> } | undefined
      return auth?.user?.() ?? null
    })

    const user = await getUser(ctx)

    if (!isEmailVerified(user)) {
      return ctx.redirect(redirectTo)
    }

    await next()
  }
}
