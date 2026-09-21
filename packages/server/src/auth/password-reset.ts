import type { UserProvider } from './types'
import { generateId, buildTokenUrl, parseTokenUrl } from './utils'
import { readSignedTokenClaims } from './signed-token'
import { MessageSigner } from '../encryption/MessageSigner'
import { deriveAppKeyring, getAppKeyringFromEnv } from '../encryption/app-key'

/**
 * Configuration for password reset tokens. Applies at issuance only: the expiry
 * is signed into the token, so the verify functions take no config.
 */
export interface PasswordResetConfig {
  /** Token expiration time in milliseconds (default: 1 hour) */
  expiresIn?: number
  /** Token byte length before encoding (default: 32) */
  tokenLength?: number
}

/**
 * Storage interface for password reset tokens. The store answers whether a
 * token ID still exists, which is what gives single use and revocation; expiry
 * is decided from the claim signed into the token.
 */
export interface PasswordResetTokenStore {
  /** Store a token ID with associated email and expiration */
  store(tokenId: string, email: string, expiresAt: Date): Promise<void>
  /** Atomically replace every token for this email. Required by token issuance. */
  replace?(tokenId: string, email: string, expiresAt: Date): Promise<void>
  /** Atomically delete this token only if its stored email matches. Required by completion. */
  consume?(tokenId: string, email: string): Promise<boolean>
  /** Find email by token ID, returns null if not found or already dropped */
  find(tokenId: string): Promise<{ email: string; expiresAt: Date } | null>
  /** Delete a token ID from storage */
  delete(tokenId: string): Promise<void>
  /** Delete all tokens for an email */
  deleteForEmail(email: string): Promise<void>
}

/** In-memory token store for testing and development. */
export class MemoryPasswordResetStore implements PasswordResetTokenStore {
  private tokens = new Map<string, { email: string; expiresAt: Date }>()

  async store(tokenId: string, email: string, expiresAt: Date): Promise<void> {
    this.tokens.set(tokenId, { email, expiresAt })
  }

  async replace(tokenId: string, email: string, expiresAt: Date): Promise<void> {
    const normalizedEmail = email.toLowerCase()
    for (const [id, record] of this.tokens) {
      if (record.email.toLowerCase() === normalizedEmail) this.tokens.delete(id)
    }
    this.tokens.set(tokenId, { email: normalizedEmail, expiresAt })
  }

  async consume(tokenId: string, email: string): Promise<boolean> {
    const record = this.tokens.get(tokenId)
    if (!record || record.email !== email) return false
    this.tokens.delete(tokenId)
    return true
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
    for (const [hash, record] of this.tokens) {
      if (record.email.toLowerCase() === email.toLowerCase()) {
        this.tokens.delete(hash)
      }
    }
  }

  /** Clear all tokens (useful for testing) */
  clear(): void {
    this.tokens.clear()
  }
}

/** Result of creating a password reset token. */
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

/** Create a password reset token for a user. */
export async function createPasswordResetToken(
  email: string,
  store: PasswordResetTokenStore,
  config: PasswordResetConfig = {},
): Promise<PasswordResetTokenResult> {
  const expiresIn = config.expiresIn ?? DEFAULT_EXPIRES_IN
  const tokenLength = config.tokenLength ?? DEFAULT_TOKEN_LENGTH

  if (!store.replace) {
    throw new Error('Password reset token issuance requires an atomic store.replace() implementation.')
  }

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

  await store.replace(tokenId, email.toLowerCase(), expiresAt)

  return { token, tokenId, expiresAt }
}

/** Verify a password reset token, returning the email it was issued for. */
export async function verifyPasswordResetToken(
  token: string,
  store: PasswordResetTokenStore,
): Promise<string | null> {
  const claims = await readSignedTokenClaims(
    createPasswordResetSigner(),
    token,
    PASSWORD_RESET_PURPOSE,
    store,
  )
  if (!claims) return null

  const record = await store.find(claims.id)
  if (!record) return null

  // Cross-check the two independently-authenticated sources: the signer
  // vouched for claims.email, the store holds record.email of its own.
  return record.email.toLowerCase() === claims.email.toLowerCase() ? record.email : null
}

/**
 * Complete a password reset: update the user's password and invalidate the
 * token. Returns the user, or `null` when the token is invalid.
 */
export async function completePasswordReset<T>(
  token: string,
  newPassword: string,
  store: PasswordResetTokenStore,
  provider: Pick<UserProvider<T>, 'retrieveByCredentials'>,
  updatePassword: (user: T, password: string) => Promise<void>,
): Promise<T | null> {
  const claims = await readSignedTokenClaims(
    createPasswordResetSigner(),
    token,
    PASSWORD_RESET_PURPOSE,
    store,
  )
  if (!claims) return null

  const record = await store.find(claims.id)
  if (!record) return null

  // Cross-check the two independently-authenticated sources: the signer
  // vouched for claims.email, the store holds record.email of its own.
  if (record.email.toLowerCase() !== claims.email.toLowerCase()) {
    return null
  }

  const user = await provider.retrieveByCredentials({ email: record.email })
  if (!user) {
    await store.delete(claims.id)
    return null
  }

  if (!store.consume) {
    throw new Error('Password reset completion requires an atomic store.consume() implementation.')
  }
  if (!await store.consume(claims.id, record.email)) return null

  // Consume before side effects; a failed callback requires a new token.
  await updatePassword(user, newPassword)

  return user
}

/** Build a password reset URL from a base URL and token. */
export const buildPasswordResetUrl = buildTokenUrl

/** Parse a password reset URL to extract the token and optional email. */
export const parsePasswordResetUrl = parseTokenUrl
