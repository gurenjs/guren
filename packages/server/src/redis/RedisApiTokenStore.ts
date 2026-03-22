import type { Redis } from 'ioredis'
import type { ApiToken, ApiTokenStore } from '../auth/api-token'
import { scanKeys } from './scan-keys'

/**
 * Options for RedisApiTokenStore.
 */
export interface RedisApiTokenStoreOptions {
  /**
   * Key prefix for token keys.
   * @default 'apitoken:'
   */
  prefix?: string
}

/**
 * Redis-backed API token store.
 *
 * Uses the following key structure:
 * - `apitoken:{id}` - Token data (hash)
 * - `apitoken:hash:{hashedToken}` - Maps hash to token ID
 * - `apitoken:user:{userId}` - Set of token IDs for a user
 *
 * @example
 * ```ts
 * import { createRedisClient } from '@guren/server/redis'
 *
 * const redis = createRedisClient({ url: process.env.REDIS_URL })
 * const store = new RedisApiTokenStore(redis)
 *
 * const { plainTextToken } = await createApiToken(store, {
 *   name: 'API Token',
 *   userId: user.id,
 * })
 * ```
 */
export class RedisApiTokenStore implements ApiTokenStore {
  private readonly prefix: string

  constructor(
    private readonly redis: Redis,
    options: RedisApiTokenStoreOptions = {}
  ) {
    this.prefix = options.prefix ?? 'apitoken:'
  }

  /**
   * Store a new API token.
   */
  async store(token: ApiToken): Promise<void> {
    const tokenKey = `${this.prefix}${token.id}`
    const hashKey = `${this.prefix}hash:${token.hashedToken}`
    const userKey = `${this.prefix}user:${token.userId}`

    const serialized = this.serializeToken(token)

    const pipeline = this.redis.pipeline()
    pipeline.hset(tokenKey, serialized)
    pipeline.set(hashKey, token.id)
    pipeline.sadd(userKey, token.id)

    // Set expiration if token has expiresAt
    if (token.expiresAt) {
      const ttl = Math.max(0, token.expiresAt.getTime() - Date.now())
      if (ttl > 0) {
        pipeline.pexpire(tokenKey, ttl)
        pipeline.pexpire(hashKey, ttl)
      }
    }

    await pipeline.exec()
  }

  /**
   * Find a token by its hashed value.
   */
  async findByHashedToken(hashedToken: string): Promise<ApiToken | null> {
    const hashKey = `${this.prefix}hash:${hashedToken}`
    const tokenId = await this.redis.get(hashKey)

    if (!tokenId) {
      return null
    }

    return this.findById(tokenId)
  }

  /**
   * Find all tokens for a user.
   */
  async findByUserId(userId: string | number): Promise<ApiToken[]> {
    const userKey = `${this.prefix}user:${userId}`
    const tokenIds = await this.redis.smembers(userKey)

    const tokens: ApiToken[] = []
    for (const id of tokenIds) {
      const token = await this.findById(id)
      if (token) {
        tokens.push(token)
      }
    }

    return tokens
  }

  /**
   * Delete a token by its ID.
   */
  async delete(id: string): Promise<void> {
    const token = await this.findById(id)
    if (!token) return

    const tokenKey = `${this.prefix}${id}`
    const hashKey = `${this.prefix}hash:${token.hashedToken}`
    const userKey = `${this.prefix}user:${token.userId}`

    const pipeline = this.redis.pipeline()
    pipeline.del(tokenKey)
    pipeline.del(hashKey)
    pipeline.srem(userKey, id)
    await pipeline.exec()
  }

  /**
   * Delete all tokens for a user.
   */
  async deleteForUser(userId: string | number): Promise<void> {
    const tokens = await this.findByUserId(userId)

    for (const token of tokens) {
      await this.delete(token.id)
    }

    // Also delete the user's token set
    const userKey = `${this.prefix}user:${userId}`
    await this.redis.del(userKey)
  }

  /**
   * Update the last used timestamp.
   */
  async updateLastUsed(id: string, timestamp: Date): Promise<void> {
    const tokenKey = `${this.prefix}${id}`
    await this.redis.hset(tokenKey, 'lastUsedAt', timestamp.toISOString())
  }

  /**
   * Find a token by its ID.
   */
  private async findById(id: string): Promise<ApiToken | null> {
    const tokenKey = `${this.prefix}${id}`
    const data = await this.redis.hgetall(tokenKey)

    if (!data || Object.keys(data).length === 0) {
      return null
    }

    return this.deserializeToken(data)
  }

  /**
   * Serialize a token for Redis storage.
   */
  private serializeToken(token: ApiToken): Record<string, string> {
    return {
      id: token.id,
      name: token.name,
      hashedToken: token.hashedToken,
      userId: String(token.userId),
      abilities: JSON.stringify(token.abilities),
      lastUsedAt: token.lastUsedAt?.toISOString() ?? '',
      expiresAt: token.expiresAt?.toISOString() ?? '',
      createdAt: token.createdAt.toISOString(),
    }
  }

  /**
   * Deserialize a token from Redis storage.
   */
  private deserializeToken(data: Record<string, string>): ApiToken {
    return {
      id: data.id,
      name: data.name,
      hashedToken: data.hashedToken,
      userId: data.userId,
      abilities: JSON.parse(data.abilities) as string[],
      lastUsedAt: data.lastUsedAt ? new Date(data.lastUsedAt) : null,
      expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
      createdAt: new Date(data.createdAt),
    }
  }

  /**
   * Clear all tokens (for testing).
   */
  async clear(): Promise<void> {
    const keys = await scanKeys(this.redis, this.prefix + '*')
    if (keys.length > 0) {
      await this.redis.del(...keys)
    }
  }
}
