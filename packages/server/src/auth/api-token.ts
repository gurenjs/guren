import type { MiddlewareHandler, Context } from 'hono'
import { hashToken, generateToken, generateId, secureCompare } from './utils'
import { isOptionalExpiryPast } from '../support/expiry'
import { AuthenticationException } from '../errors/exceptions/AuthenticationException'

/**
 * API token data stored in the backing store.
 */
export interface ApiToken {
  id: string
  name: string
  hashedToken: string
  userId: string | number
  abilities: string[]
  lastUsedAt: Date | null
  expiresAt: Date | null
  createdAt: Date
}

/**
 * Store interface for API tokens.
 * Implement this for database-backed storage.
 */
export interface ApiTokenStore {
  store(token: ApiToken): Promise<void>

  findByHashedToken(hashedToken: string): Promise<ApiToken | null>

  findByUserId(userId: string | number): Promise<ApiToken[]>

  delete(id: string): Promise<void>

  deleteForUser(userId: string | number): Promise<void>

  updateLastUsed(id: string, timestamp: Date): Promise<void>
}

/**
 * In-memory token store for testing.
 * Do NOT use in production - tokens will be lost on restart.
 */
export class MemoryApiTokenStore implements ApiTokenStore {
  private tokens: Map<string, ApiToken> = new Map()
  private byHash: Map<string, string> = new Map()

  async store(token: ApiToken): Promise<void> {
    this.tokens.set(token.id, token)
    this.byHash.set(token.hashedToken, token.id)
  }

  async findByHashedToken(hashedToken: string): Promise<ApiToken | null> {
    const id = this.byHash.get(hashedToken)
    if (!id) return null
    return this.tokens.get(id) ?? null
  }

  async findByUserId(userId: string | number): Promise<ApiToken[]> {
    const userIdStr = String(userId)
    return Array.from(this.tokens.values()).filter(
      (t) => String(t.userId) === userIdStr
    )
  }

  async delete(id: string): Promise<void> {
    const token = this.tokens.get(id)
    if (token) {
      this.byHash.delete(token.hashedToken)
      this.tokens.delete(id)
    }
  }

  async deleteForUser(userId: string | number): Promise<void> {
    const userIdStr = String(userId)
    for (const [id, token] of this.tokens.entries()) {
      if (String(token.userId) === userIdStr) {
        this.byHash.delete(token.hashedToken)
        this.tokens.delete(id)
      }
    }
  }

  async updateLastUsed(id: string, timestamp: Date): Promise<void> {
    const token = this.tokens.get(id)
    if (token) {
      token.lastUsedAt = timestamp
    }
  }

  clear(): void {
    this.tokens.clear()
    this.byHash.clear()
  }

  get size(): number {
    return this.tokens.size
  }
}

/**
 * Configuration for API token creation.
 */
export interface CreateApiTokenOptions {
  name: string

  userId: string | number

  /** @default ['*'] (all abilities) */
  abilities?: string[]

  /**
   * Expiration in milliseconds from now.
   * @default null (never expires)
   */
  expiresIn?: number | null

  /**
   * Token byte length, before encoding.
   * @default 32
   */
  tokenLength?: number
}

/**
 * Result of creating an API token.
 */
export interface CreateApiTokenResult {
  /**
   * The full token to give to the user, formatted `{id}|{plainToken}`.
   * This is the ONLY time the plain token is available.
   */
  plainTextToken: string

  token: ApiToken
}


/**
 * Create a new API token.
 */
export async function createApiToken(
  store: ApiTokenStore,
  options: CreateApiTokenOptions
): Promise<CreateApiTokenResult> {
  const {
    name,
    userId,
    abilities = ['*'],
    expiresIn = null,
    tokenLength = 32,
  } = options

  const id = generateId()
  const plainToken = generateToken(tokenLength)
  const hashedToken = hashToken(plainToken)
  const now = new Date()

  const token: ApiToken = {
    id,
    name,
    hashedToken,
    userId,
    abilities,
    lastUsedAt: null,
    expiresAt: expiresIn == null ? null : new Date(now.getTime() + expiresIn),
    createdAt: now,
  }

  await store.store(token)

  return {
    plainTextToken: `${id}|${plainToken}`,
    token,
  }
}

/**
 * Parse a plain text token into its components.
 */
export function parseApiToken(plainTextToken: string): { id: string; token: string } | null {
  const parts = plainTextToken.split('|')
  if (parts.length !== 2) return null

  const [id, token] = parts
  if (!id || !token) return null

  return { id, token }
}

/**
 * Extract the bearer token from an Authorization header. The one parsing rule
 * shared by `createBearerTokenMiddleware`, `TokenGuard` and `hasBearerHeader`.
 * `\S` keeps the match linear — `\s+(.+)` backtracks quadratically when a
 * trailing newline makes `$` unreachable, on a pre-authentication header — and
 * makes an all-whitespace token "not a bearer request", so CSRF is not skipped.
 */
export function readBearerToken(header: string | undefined | null): string | null {
  if (!header) return null
  const match = header.match(/^Bearer\s+(\S.*)$/i)
  return match ? match[1] : null
}

/**
 * The one answer to "is this request bearer-authenticated?", shared by
 * `AuthManager.resolveGuardName` and the CSRF skip for cookie-less bearer
 * requests, which must classify a request identically.
 */
export function hasBearerHeader(ctx: Context): boolean {
  return readBearerToken(ctx.req.header('Authorization')) !== null
}

/**
 * The result of a successful bearer-token verification: the stored token
 * record plus the fields most callers need directly.
 */
export interface VerifiedApiToken {
  token: ApiToken
  userId: string | number
  abilities: string[]
}

/**
 * Verify an API token and return the associated user ID.
 */
export async function verifyApiToken(
  plainTextToken: string,
  store: ApiTokenStore,
  options: { updateLastUsed?: boolean } = {}
): Promise<VerifiedApiToken | null> {
  const { updateLastUsed = true } = options

  const parsed = parseApiToken(plainTextToken)
  if (!parsed) return null

  const hashedToken = hashToken(parsed.token)
  const token = await store.findByHashedToken(hashedToken)

  if (!token) return null

  // Verify the ID matches (prevents using hash from one token with ID of another)
  if (token.id !== parsed.id) return null

  // Authoritative expiry check: Memory and app-supplied stores never run the
  // deserialization guards, and `createApiToken` can mint an Invalid Date from
  // a non-finite `expiresIn`, so the predicate treats unparseable as expired.
  if (isOptionalExpiryPast(token.expiresAt)) {
    return null
  }

  if (!secureCompare(token.hashedToken, hashedToken)) {
    return null
  }

  if (updateLastUsed) {
    await store.updateLastUsed(token.id, new Date())
  }

  return {
    token,
    userId: token.userId,
    abilities: token.abilities,
  }
}

/**
 * Check if a token has a specific ability.
 */
export function tokenCan(token: ApiToken | { abilities: string[] }, ability: string): boolean {
  if (token.abilities.includes('*')) return true
  return token.abilities.includes(ability)
}

/**
 * Check if a token has all specified abilities.
 */
export function tokenCanAll(
  token: ApiToken | { abilities: string[] },
  abilities: string[]
): boolean {
  if (token.abilities.includes('*')) return true
  return abilities.every((ability) => token.abilities.includes(ability))
}

/**
 * Check if a token has any of the specified abilities.
 */
export function tokenCanAny(
  token: ApiToken | { abilities: string[] },
  abilities: string[]
): boolean {
  if (token.abilities.includes('*')) return true
  return abilities.some((ability) => token.abilities.includes(ability))
}

/**
 * Revoke (delete) an API token.
 */
export async function revokeApiToken(id: string, store: ApiTokenStore): Promise<void> {
  await store.delete(id)
}

/**
 * Revoke all API tokens for a user.
 */
export async function revokeAllApiTokens(
  userId: string | number,
  store: ApiTokenStore
): Promise<void> {
  await store.deleteForUser(userId)
}

/**
 * Get all API tokens for a user.
 */
export async function getUserApiTokens(
  userId: string | number,
  store: ApiTokenStore
): Promise<ApiToken[]> {
  return store.findByUserId(userId)
}

/**
 * Context key for storing the authenticated token.
 */
export const API_TOKEN_KEY = 'guren:api-token'

/**
 * Options for the bearer token middleware.
 */
export interface BearerTokenMiddlewareOptions {
  store: ApiTokenStore

  loadUser?: (userId: string | number) => Promise<unknown>

  /** Required abilities. Any valid token is accepted when unset. */
  abilities?: string[]

  onUnauthorized?: (ctx: Context) => Response | Promise<Response>

  onForbidden?: (ctx: Context, required: string[]) => Response | Promise<Response>

  /** @default 'Authorization' */
  headerName?: string

  /** @default true */
  updateLastUsed?: boolean
}

/**
 * Create middleware that authenticates requests using Bearer tokens.
 * @example
 * ```ts
 * app.use('/api/*', createBearerTokenMiddleware({ store, abilities: ['posts:delete'] }))
 * ```
 */
export function createBearerTokenMiddleware(
  options: BearerTokenMiddlewareOptions
): MiddlewareHandler {
  const {
    store,
    loadUser,
    abilities,
    onUnauthorized,
    onForbidden,
    headerName = 'Authorization',
    updateLastUsed = true,
  } = options

  return async (ctx, next) => {
    const authHeader = ctx.req.header(headerName)
    if (!authHeader) {
      if (onUnauthorized) return onUnauthorized(ctx)
      return ctx.json({ error: 'Authentication required' }, 401)
    }

    const plainTextToken = readBearerToken(authHeader)
    if (!plainTextToken) {
      if (onUnauthorized) return onUnauthorized(ctx)
      return ctx.json({ error: 'Invalid authorization format' }, 401)
    }

    const result = await verifyApiToken(plainTextToken, store, { updateLastUsed })
    if (!result) {
      if (onUnauthorized) return onUnauthorized(ctx)
      return ctx.json({ error: 'Invalid or expired token' }, 401)
    }

    if (abilities && abilities.length > 0) {
      if (!tokenCanAll(result.token, abilities)) {
        if (onForbidden) return onForbidden(ctx, abilities)
        return ctx.json(
          { error: 'Token lacks required abilities', required: abilities },
          403
        )
      }
    }

    ctx.set(API_TOKEN_KEY, result)

    if (loadUser) {
      const user = await loadUser(result.userId)
      ctx.set('guren:user', user)
    }

    return next()
  }
}

/**
 * Get the authenticated API token from the request context.
 */
export function getApiToken(
  ctx: Context
): { token: ApiToken; userId: string | number; abilities: string[] } | null {
  return ctx.get(API_TOKEN_KEY) as {
    token: ApiToken
    userId: string | number
    abilities: string[]
  } | null
}

/**
 * Get the authenticated API token from the request context, or throw.
 *
 * @throws {AuthenticationException} When no token is present in the context.
 */
export function getApiTokenOrFail(
  ctx: Context
): { token: ApiToken; userId: string | number; abilities: string[] } {
  const result = getApiToken(ctx)
  if (!result) {
    throw new AuthenticationException('Unauthenticated.')
  }
  return result
}
