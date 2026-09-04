import type { Authenticatable, UserProvider } from './types'
import { generateId, buildTokenUrl, parseTokenUrl } from './utils'
import { readSignedTokenClaims } from './signed-token'
import { MessageSigner } from '../encryption/MessageSigner'
import { deriveAppKeyring, getAppKeyringFromEnv } from '../encryption/app-key'

/**
 * Configuration for password reset tokens.
 *
 * Applies at issuance only: `createPasswordResetToken` signs the expiry into
 * the token, so `verifyPasswordResetToken` and `completePasswordReset` take no
 * configuration. Changing `expiresIn` affects tokens issued from then on, not
 * tokens already sent.
 */
export interface PasswordResetConfig {
  /** Token expiration time in milliseconds (default: 1 hour) */
  expiresIn?: number
  /** Token byte length before encoding (default: 32) */
  tokenLength?: number
}

/**
 * Storage interface for password reset tokens.
 *
 * The store answers "does this token id still exist" — single use and
 * revocation. Expiry is decided from the claim signed into the token, so a
 * store may drop expired records for housekeeping (the built-in stores do),
 * but verification never relies on it doing so.
 */
export interface PasswordResetTokenStore {
  /** Store a token ID with associated email and expiration */
  store(tokenId: string, email: string, expiresAt: Date): Promise<void>
  /** Find email by token ID, returns null if not found (or already dropped as expired) */
  find(tokenId: string): Promise<{ email: string; expiresAt: Date } | null>
  /** Delete a token ID from storage */
  delete(tokenId: string): Promise<void>
  /** Delete all tokens for an email */
  deleteForEmail(email: string): Promise<void>
}

/**
 * In-memory token store for testing and development.
 */
export class MemoryPasswordResetStore implements PasswordResetTokenStore {
  private tokens = new Map<string, { email: string; expiresAt: Date }>()

  async store(tokenId: string, email: string, expiresAt: Date): Promise<void> {
    this.tokens.set(tokenId, { email, expiresAt })
  }

  async find(tokenId: string): Promise<{ email: string; expiresAt: Date } | null> {
    const record = this.tokens.get(tokenId)
    if (!record) return null
    if (record.expiresAt < new Date()) {
      this.tokens.delete(tokenId)
      return null
    }
    return record
  }

  async delete(tokenId: string): Promise<void> {
    this.tokens.delete(tokenId)
  }

  async deleteForEmail(email: string): Promise<void> {
    for (const [tokenId, record] of this.tokens) {
      if (record.email === email) {
        this.tokens.delete(tokenId)
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
  /** The token ID stored in the backing store */
  tokenId: string
  /** When the token expires */
  expiresAt: Date
}

const DEFAULT_EXPIRES_IN = 60 * 60 * 1000 // 1 hour
const DEFAULT_TOKEN_LENGTH = 32
const PASSWORD_RESET_PURPOSE = 'password-reset'

function createPasswordResetSigner(): MessageSigner {
  return new MessageSigner(deriveAppKeyring(getAppKeyringFromEnv(), 'password-reset-signing'))
}

/**
 * Create a password reset token for a user.
 *
 * @param email - The user's email address
 * @param store - The token storage implementation
 * @param config - Optional configuration
 * @returns The token result containing the plain token and its store id
 */
export async function createPasswordResetToken(
  email: string,
  store: PasswordResetTokenStore,
  config: PasswordResetConfig = {},
): Promise<PasswordResetTokenResult> {
  const expiresIn = config.expiresIn ?? DEFAULT_EXPIRES_IN
  const tokenLength = config.tokenLength ?? DEFAULT_TOKEN_LENGTH

  // Delete any existing tokens for this email
  await store.deleteForEmail(email)

  const tokenId = generateId()
  const expiresAt = new Date(Date.now() + expiresIn)
  const signer = createPasswordResetSigner()
  const token = signer.sign(
    {
      id: tokenId,
      email: email.toLowerCase(),
      bytes: tokenLength,
    },
    {
      purpose: PASSWORD_RESET_PURPOSE,
      expiresIn,
    },
  )

  await store.store(tokenId, email.toLowerCase(), expiresAt)

  return { token, tokenId, expiresAt }
}

/**
 * Verify a password reset token.
 *
 * Expiry comes from the claim signed into the token; the store is consulted
 * only for whether the token id still exists.
 *
 * @param token - The plain-text token from the reset URL
 * @param store - The token storage implementation
 * @returns The email if token is valid, null otherwise
 */
export async function verifyPasswordResetToken(
  token: string,
  store: PasswordResetTokenStore,
): Promise<string | null> {
  const claims = await readSignedTokenClaims(
    createPasswordResetSigner(),
    token,
    PASSWORD_RESET_PURPOSE,
    (id) => store.delete(id),
  )
  if (!claims) return null

  const record = await store.find(claims.id)
  if (!record) return null
  return record.email.toLowerCase() === claims.email.toLowerCase() ? record.email : null
}

/**
 * Complete a password reset by updating the user's password and invalidating the token.
 *
 * @param token - The plain-text token from the reset URL
 * @param newPassword - The new password (should be validated by caller)
 * @param store - The token storage implementation
 * @param provider - The user provider to look up and update the user
 * @param updatePassword - Function to update the user's password
 * @returns The user if reset was successful, null if token is invalid
 */
export async function completePasswordReset<T extends Authenticatable>(
  token: string,
  newPassword: string,
  store: PasswordResetTokenStore,
  provider: UserProvider<T>,
  updatePassword: (user: T, password: string) => Promise<void>,
): Promise<T | null> {
  const claims = await readSignedTokenClaims(
    createPasswordResetSigner(),
    token,
    PASSWORD_RESET_PURPOSE,
    (id) => store.delete(id),
  )
  if (!claims) return null

  const record = await store.find(claims.id)
  if (!record) return null

  // Verify email matches between token and store
  if (record.email.toLowerCase() !== claims.email.toLowerCase()) {
    return null
  }

  const user = await provider.retrieveByCredentials({ email: record.email })
  if (!user) {
    await store.delete(claims.id)
    return null
  }

  // Update password
  await updatePassword(user, newPassword)

  // Invalidate token
  await store.delete(claims.id)

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
