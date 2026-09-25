import { getAuthContext } from './context'
import { isAgentToolRequest, type HeaderReader } from '../internal/agent-request'
import { jsonResponse } from '../http/middleware'
import { generateId, buildTokenUrl, parseTokenUrl } from './utils'
import { readSignedTokenClaims } from './signed-token'
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

/**
 * Store interface for email verification tokens. The store answers whether a
 * token ID still exists, which is what gives single use and revocation; expiry
 * is decided from the claim signed into the token.
 */
export interface EmailVerificationTokenStore {
  /** Store a new verification token. */
  store(token: EmailVerificationToken): Promise<void>

  /** Atomically replace every token for this email. Required by token issuance. */
  replace?(token: EmailVerificationToken): Promise<void>

  /** Atomically delete this token only if its stored email matches. Required by completion. */
  consume?(tokenId: string, email: string): Promise<boolean>

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

  async replace(token: EmailVerificationToken): Promise<void> {
    const email = token.email.toLowerCase()
    for (const [id, record] of this.tokens) {
      if (record.email.toLowerCase() === email) this.tokens.delete(id)
    }
    this.tokens.set(token.tokenId, { ...token, email })
  }

  async consume(tokenId: string, email: string): Promise<boolean> {
    const record = this.tokens.get(tokenId)
    if (!record || record.email !== email) return false
    this.tokens.delete(tokenId)
    return true
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

/**
 * Configuration options for email verification. Applies at issuance only: the
 * expiry is signed into the token, so the verify functions take no config.
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

  if (!store.replace) {
    throw new Error('Email verification token issuance requires an atomic store.replace() implementation.')
  }

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

  await store.replace({
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
): Promise<string | null> {
  const claims = await readSignedTokenClaims(
    createEmailVerificationSigner(),
    token,
    EMAIL_VERIFICATION_PURPOSE,
    store,
  )
  if (!claims) return null

  const storedToken = await store.findByTokenId(claims.id)
  if (!storedToken) return null

  // Cross-check the two independently-authenticated sources: the signer
  // vouched for claims.email, the store holds storedToken.email of its own.
  return storedToken.email.toLowerCase() === claims.email.toLowerCase()
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
  const claims = await readSignedTokenClaims(
    createEmailVerificationSigner(),
    token,
    EMAIL_VERIFICATION_PURPOSE,
    store,
  )
  if (!claims) return null

  const storedToken = await store.findByTokenId(claims.id)
  if (!storedToken) return null

  // Cross-check the two independently-authenticated sources: the signer
  // vouched for claims.email, the store holds storedToken.email of its own.
  if (storedToken.email.toLowerCase() !== claims.email.toLowerCase()) {
    return null
  }

  if (!store.consume) {
    throw new Error('Email verification completion requires an atomic store.consume() implementation.')
  }
  if (!await store.consume(claims.id, storedToken.email)) return null

  // Consume before side effects; a failed callback requires a new token.
  return markVerified(storedToken.email)
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
 * @example
 * ```ts
 * requireVerifiedEmail({ redirectTo: '/verify-email' })
 * ```
 */
export function requireVerifiedEmail(options: {
  redirectTo?: string
  // `get` mirrors Hono's own context idiom: the type argument is inferred from
  // the expected type, so `const auth: AuthContext | undefined = ctx.get(AUTH_CONTEXT_KEY)`
  // needs no cast.
  getUser?: (ctx: { get: <T = unknown>(key: string) => T }) => Promise<{ emailVerifiedAt?: Date | null } | null>
} = {}) {
  const { redirectTo = '/verify-email' } = options

  return async (
    ctx: { get: <T = unknown>(key: string) => T; redirect: (url: string) => Response } & HeaderReader,
    next: () => Promise<void>,
  ) => {
    const getUser = options.getUser ?? (async (c: { get: <T = unknown>(key: string) => T }) => {
      const auth = getAuthContext(c)
      return (await auth?.user<{ emailVerifiedAt?: Date | null }>()) ?? null
    })

    const user = await getUser(ctx)

    if (!isEmailVerified(user)) {
      // Same rule as requireAuthenticated: see internal/agent-request.ts.
      return isAgentToolRequest(ctx)
        ? jsonResponse({ message: 'Email address is not verified' }, 403)
        : ctx.redirect(redirectTo)
    }

    await next()
  }
}
