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
  /**
   * Store a new API token.
   */
  store(token: ApiToken): Promise<void>

  /**
   * Find a token by its hashed value.
   */
  findByHashedToken(hashedToken: string): Promise<ApiToken | null>

  /**
   * Find all tokens for a user.
   */
  findByUserId(userId: string | number): Promise<ApiToken[]>

  /**
   * Delete a token by its ID.
   */
  delete(id: string): Promise<void>

  /**
   * Delete all tokens for a user.
   */
  deleteForUser(userId: string | number): Promise<void>

  /**
   * Update the last used timestamp.
   */
  updateLastUsed(id: string, timestamp: Date): Promise<void>
}

/**
 * In-memory token store for testing.
 * Do NOT use in production - tokens will be lost on restart.
 */
export class MemoryApiTokenStore implements ApiTokenStore {
  private tokens: Map<string, ApiToken> = new Map()
  private byHash: Map<string, string> = new Map() // hash -> id

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

  /**
   * Clear all tokens (useful for testing).
   */
  clear(): void {
    this.tokens.clear()
    this.byHash.clear()
  }

  /**
   * Get the number of stored tokens.
   */
  get size(): number {
    return this.tokens.size
  }
}

/**
 * Configuration for API token creation.
 */
export interface CreateApiTokenOptions {
  /**
   * Human-readable name for the token.
   */
  name: string

  /**
   * User ID the token belongs to.
   */
  userId: string | number

  /**
   * Token abilities/scopes.
   * @default ['*'] (all abilities)
   */
  abilities?: string[]

  /**
   * Token expiration time in milliseconds from now.
   * @default null (never expires)
   */
  expiresIn?: number | null

  /**
   * Token byte length (before encoding).
   * @default 32
   */
  tokenLength?: number
}

/**
 * Result of creating an API token.
 */
export interface CreateApiTokenResult {
  /**
   * The full token to give to the user.
   * Format: {id}|{plainToken}
   * This is the ONLY time the plain token is available.
   */
  plainTextToken: string

  /**
   * The token record (without the plain token).
   */
  token: ApiToken
}


/**
 * Create a new API token.
 *
 * @example
 * ```ts
 * const { plainTextToken, token } = await createApiToken(store, {
 *   name: 'My App Token',
 *   userId: user.id,
 *   abilities: ['read', 'write'],
 *   expiresIn: 30 * 24 * 60 * 60 * 1000, // 30 days
 * })
 *
 * // Return plainTextToken to user - this is the only time it's available
 * return ctx.json({ token: plainTextToken })
 * ```
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
 * Extract the bearer token from an Authorization header value. The one
 * parsing rule shared by `createBearerTokenMiddleware`, `TokenGuard`, and
 * `hasBearerHeader` below — three readers of the same header must not
 * disagree about what a bearer request is.
 *
 * The `\S` anchoring the capture is load-bearing, not cosmetic: `\s+(.+)`
 * lets the separator and the token both match a space, so an attacker-supplied
 * `Bearer` + many spaces + a newline (`.` never matches one, so `$` is
 * unreachable) makes the engine retry every split of the whitespace run —
 * quadratic in the header length, on a header read before any authentication.
 * Requiring the token to start with a non-space removes the overlap. The only
 * input whose result changes is an all-whitespace token, which was never a
 * token: it now reads as "not a bearer request" rather than as a bearer
 * request carrying a space, so CSRF is no longer skipped for it.
 */
export function readBearerToken(header: string | undefined | null): string | null {
  if (!header) return null
  const match = header.match(/^Bearer\s+(\S.*)$/i)
  return match ? match[1] : null
}

/**
 * The one answer to "is this request bearer-authenticated?" — the parsing
 * rule above applied to the header it is read from. Shared by guard selection
 * (`AuthManager.resolveGuardName`) and the CSRF skip for cookie-less bearer
 * requests: both must classify a request identically, and a second copy of
 * the header name is how they would drift apart.
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
 *
 * @example
 * ```ts
 * const result = await verifyApiToken(plainTextToken, store)
 *
 * if (!result) {
 *   return ctx.json({ error: 'Invalid token' }, 401)
 * }
 *
 * console.log(`User ${result.userId} authenticated with abilities:`, result.abilities)
 * ```
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

  // Check expiration. This is the authoritative check — every store hands its
  // records here, including Memory and app-supplied ones that never run the
  // deserialization guards, and `createApiToken` itself can mint an Invalid
  // Date from a non-finite `expiresIn`. Comparing the Date directly would read
  // any of those as "not past", so the predicate treats unparseable as expired.
  if (isOptionalExpiryPast(token.expiresAt)) {
    return null
  }

  // Securely verify the hash
  if (!secureCompare(token.hashedToken, hashedToken)) {
    return null
  }

  // Update last used timestamp
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
  // Wildcard grants all abilities
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
 *
 * @example
 * ```ts
 * await revokeApiToken(tokenId, store)
 * ```
 */
export async function revokeApiToken(id: string, store: ApiTokenStore): Promise<void> {
  await store.delete(id)
}

/**
 * Revoke all API tokens for a user.
 *
 * @example
 * ```ts
 * // Revoke all tokens when user changes password
 * await revokeAllApiTokens(user.id, store)
 * ```
 */
export async function revokeAllApiTokens(
  userId: string | number,
  store: ApiTokenStore
): Promise<void> {
  await store.deleteForUser(userId)
}

/**
 * Get all API tokens for a user.
 *
 * @example
 * ```ts
 * const tokens = await getUserApiTokens(user.id, store)
 * // Returns tokens without the plain text (only metadata)
 * ```
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
  /**
   * Token store implementation.
   */
  store: ApiTokenStore

  /**
   * Function to load the user from the user ID.
   */
  loadUser?: (userId: string | number) => Promise<unknown>

  /**
   * Required abilities for this route.
   * If not specified, any valid token is accepted.
   */
  abilities?: string[]

  /**
   * Custom handler when authentication fails.
   */
  onUnauthorized?: (ctx: Context) => Response | Promise<Response>

  /**
   * Custom handler when token lacks required abilities.
   */
  onForbidden?: (ctx: Context, required: string[]) => Response | Promise<Response>

  /**
   * Header name to extract the token from.
   * @default 'Authorization'
   */
  headerName?: string

  /**
   * Whether to update the token's lastUsedAt timestamp.
   * @default true
   */
  updateLastUsed?: boolean
}

/**
 * Create middleware that authenticates requests using Bearer tokens.
 *
 * @example
 * ```ts
 * // Basic usage
 * app.use('/api/*', createBearerTokenMiddleware({ store }))
 *
 * // With ability requirement
 * router.delete('/api/posts/:id', [PostController, 'destroy'],
 *   createBearerTokenMiddleware({
 *     store,
 *     abilities: ['posts:delete'],
 *   })
 * )
 *
 * // With user loading
 * app.use('/api/*', createBearerTokenMiddleware({
 *   store,
 *   loadUser: async (userId) => User.find(userId),
 * }))
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
    // Extract token from Authorization header
    const authHeader = ctx.req.header(headerName)
    if (!authHeader) {
      if (onUnauthorized) return onUnauthorized(ctx)
      return ctx.json({ error: 'Authentication required' }, 401)
    }

    // Parse Bearer token
    const plainTextToken = readBearerToken(authHeader)
    if (!plainTextToken) {
      if (onUnauthorized) return onUnauthorized(ctx)
      return ctx.json({ error: 'Invalid authorization format' }, 401)
    }

    // Verify token
    const result = await verifyApiToken(plainTextToken, store, { updateLastUsed })
    if (!result) {
      if (onUnauthorized) return onUnauthorized(ctx)
      return ctx.json({ error: 'Invalid or expired token' }, 401)
    }

    // Check abilities if required
    if (abilities && abilities.length > 0) {
      if (!tokenCanAll(result.token, abilities)) {
        if (onForbidden) return onForbidden(ctx, abilities)
        return ctx.json(
          { error: 'Token lacks required abilities', required: abilities },
          403
        )
      }
    }

    // Store token info in context
    ctx.set(API_TOKEN_KEY, result)

    // Load and store user if loadUser provided
    if (loadUser) {
      const user = await loadUser(result.userId)
      ctx.set('guren:user', user)
    }

    return next()
  }
}

/**
 * Get the authenticated API token from the request context.
 *
 * @example
 * ```ts
 * router.get('/api/me', async (ctx) => {
 *   const { token, userId, abilities } = getApiToken(ctx)!
 *   return ctx.json({ userId, tokenName: token.name, abilities })
 * })
 * ```
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
 *
 * @example
 * ```ts
 * router.get('/api/me', async (ctx) => {
 *   const { token, userId, abilities } = getApiTokenOrFail(ctx)
 *   return ctx.json({ userId, tokenName: token.name, abilities })
 * })
 * ```
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
