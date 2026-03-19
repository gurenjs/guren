import type { Authenticatable, UserProvider } from './types'
import { hashToken, generateToken, buildTokenUrl, parseTokenUrl } from './utils'

/**
 * Configuration for password reset tokens.
 */
export interface PasswordResetConfig {
  /** Token expiration time in milliseconds (default: 1 hour) */
  expiresIn?: number
  /** Hash algorithm for token storage (default: 'sha256') */
  hashAlgorithm?: 'sha256' | 'sha512'
  /** Token byte length before encoding (default: 32) */
  tokenLength?: number
}

/**
 * Storage interface for password reset tokens.
 */
export interface PasswordResetTokenStore {
  /** Store a token hash with associated email and expiration */
  store(tokenHash: string, email: string, expiresAt: Date): Promise<void>
  /** Find email by token hash, returns null if not found or expired */
  find(tokenHash: string): Promise<{ email: string; expiresAt: Date } | null>
  /** Delete a token hash from storage */
  delete(tokenHash: string): Promise<void>
  /** Delete all tokens for an email */
  deleteForEmail(email: string): Promise<void>
}

/**
 * In-memory token store for testing and development.
 */
export class MemoryPasswordResetStore implements PasswordResetTokenStore {
  private tokens = new Map<string, { email: string; expiresAt: Date }>()

  async store(tokenHash: string, email: string, expiresAt: Date): Promise<void> {
    this.tokens.set(tokenHash, { email, expiresAt })
  }

  async find(tokenHash: string): Promise<{ email: string; expiresAt: Date } | null> {
    const record = this.tokens.get(tokenHash)
    if (!record) return null
    if (record.expiresAt < new Date()) {
      this.tokens.delete(tokenHash)
      return null
    }
    return record
  }

  async delete(tokenHash: string): Promise<void> {
    this.tokens.delete(tokenHash)
  }

  async deleteForEmail(email: string): Promise<void> {
    for (const [hash, record] of this.tokens) {
      if (record.email === email) {
        this.tokens.delete(hash)
      }
    }
  }

  /** Clear all tokens (useful for testing) */
  clear(): void {
    this.tokens.clear()
  }
}

/**
 * Result of creating a password reset token.
 */
export interface PasswordResetTokenResult {
  /** The plain-text token to send to the user (via email) */
  token: string
  /** The token hash stored in the database */
  tokenHash: string
  /** When the token expires */
  expiresAt: Date
}

const DEFAULT_EXPIRES_IN = 60 * 60 * 1000 // 1 hour
const DEFAULT_TOKEN_LENGTH = 32
const DEFAULT_HASH_ALGORITHM = 'sha256'

/**
 * Create a password reset token for a user.
 *
 * @param email - The user's email address
 * @param store - The token storage implementation
 * @param config - Optional configuration
 * @returns The token result containing plain token and hash
 */
export async function createPasswordResetToken(
  email: string,
  store: PasswordResetTokenStore,
  config: PasswordResetConfig = {},
): Promise<PasswordResetTokenResult> {
  const expiresIn = config.expiresIn ?? DEFAULT_EXPIRES_IN
  const tokenLength = config.tokenLength ?? DEFAULT_TOKEN_LENGTH
  const hashAlgorithm = config.hashAlgorithm ?? DEFAULT_HASH_ALGORITHM

  // Delete any existing tokens for this email
  await store.deleteForEmail(email)

  // Generate new token
  const token = generateToken(tokenLength)
  const tokenHash = hashToken(token, hashAlgorithm)
  const expiresAt = new Date(Date.now() + expiresIn)

  // Store the hash
  await store.store(tokenHash, email, expiresAt)

  return { token, tokenHash, expiresAt }
}

/**
 * Verify a password reset token.
 *
 * @param token - The plain-text token from the reset URL
 * @param store - The token storage implementation
 * @param config - Optional configuration (must match createPasswordResetToken config)
 * @returns The email if token is valid, null otherwise
 */
export async function verifyPasswordResetToken(
  token: string,
  store: PasswordResetTokenStore,
  config: PasswordResetConfig = {},
): Promise<string | null> {
  const hashAlgorithm = config.hashAlgorithm ?? DEFAULT_HASH_ALGORITHM
  const tokenHash = hashToken(token, hashAlgorithm)

  const record = await store.find(tokenHash)
  if (!record) return null

  return record.email
}

/**
 * Complete a password reset by updating the user's password and invalidating the token.
 *
 * @param token - The plain-text token from the reset URL
 * @param newPassword - The new password (should be validated by caller)
 * @param store - The token storage implementation
 * @param provider - The user provider to look up and update the user
 * @param updatePassword - Function to update the user's password
 * @param config - Optional configuration
 * @returns The user if reset was successful, null if token is invalid
 */
export async function completePasswordReset<T extends Authenticatable>(
  token: string,
  newPassword: string,
  store: PasswordResetTokenStore,
  provider: UserProvider<T>,
  updatePassword: (user: T, password: string) => Promise<void>,
  config: PasswordResetConfig = {},
): Promise<T | null> {
  const hashAlgorithm = config.hashAlgorithm ?? DEFAULT_HASH_ALGORITHM
  const tokenHash = hashToken(token, hashAlgorithm)

  const record = await store.find(tokenHash)
  if (!record) return null

  const user = await provider.retrieveByCredentials({ email: record.email })
  if (!user) {
    // Token valid but user doesn't exist - clean up and return null
    await store.delete(tokenHash)
    return null
  }

  // Update password
  await updatePassword(user, newPassword)

  // Invalidate token
  await store.delete(tokenHash)

  return user
}

/**
 * Build a password reset URL from a base URL and token.
 */
export const buildPasswordResetUrl = buildTokenUrl

/**
 * Parse a password reset URL to extract the token and optional email.
 */
export const parsePasswordResetUrl = parseTokenUrl
