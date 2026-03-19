import { hashToken, generateToken, buildTokenUrl, parseTokenUrl } from './utils'

/**
 * Email verification token data stored in the backing store.
 * Only the hashed token is stored for security.
 */
export interface EmailVerificationToken {
  email: string
  hashedToken: string
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
   * Find a token by its hashed value.
   */
  findByHashedToken(hashedToken: string): Promise<EmailVerificationToken | null>

  /**
   * Delete a token by its hashed value.
   */
  delete(hashedToken: string): Promise<void>

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
    this.tokens.set(token.hashedToken, token)
  }

  async findByHashedToken(hashedToken: string): Promise<EmailVerificationToken | null> {
    return this.tokens.get(hashedToken) ?? null
  }

  async delete(hashedToken: string): Promise<void> {
    this.tokens.delete(hashedToken)
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
  const token = generateToken(tokenLength)
  const hashedToken = hashToken(token)
  const now = new Date()
  const expiresAt = new Date(now.getTime() + expiresIn)

  await store.store({
    email: email.toLowerCase(),
    hashedToken,
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
  const hashedToken = hashToken(token)
  const storedToken = await store.findByHashedToken(hashedToken)

  if (!storedToken) {
    return null
  }

  // Check if expired
  if (new Date() > storedToken.expiresAt) {
    await store.delete(hashedToken)
    return null
  }

  return storedToken.email
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
  const hashedToken = hashToken(token)
  const storedToken = await store.findByHashedToken(hashedToken)

  if (!storedToken) {
    return null
  }

  // Check if expired
  if (new Date() > storedToken.expiresAt) {
    await store.delete(hashedToken)
    return null
  }

  // Mark as verified
  const result = await markVerified(storedToken.email)

  // Delete the used token
  await store.delete(hashedToken)

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
 * Route.get('/dashboard', [DashboardController, 'index'],
 *   requireAuthenticated(),
 *   requireVerifiedEmail({ redirectTo: '/verify-email' })
 * )
 * ```
 */
export function requireVerifiedEmail(options: {
  redirectTo?: string
  getUser?: (ctx: unknown) => Promise<{ emailVerifiedAt?: Date | null } | null>
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
