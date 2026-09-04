import type { Redis } from 'ioredis'
import type { ApiToken, ApiTokenStore } from '../auth/api-token'
import { scanKeys } from './scan-keys'
import { decodeAbilities } from './redis-values'
import { toDate, toOptionalExpiry } from '../support/expiry'

export interface RedisApiTokenStoreOptions {
  /** @default 'apitoken:' */
  prefix?: string
}

/**
 * Key layout: `apitoken:{id}` Hash of token data, `apitoken:hash:{hashedToken}`
 * hash → token ID, `apitoken:user:{userId}` Set of a user's token IDs.
 */
export class RedisApiTokenStore implements ApiTokenStore {
  private readonly prefix: string

  constructor(
    private readonly redis: Redis,
    options: RedisApiTokenStoreOptions = {}
  ) {
    this.prefix = options.prefix ?? 'apitoken:'
  }

  async store(token: ApiToken): Promise<void> {
    const tokenKey = `${this.prefix}${token.id}`
    const hashKey = `${this.prefix}hash:${token.hashedToken}`
    const userKey = `${this.prefix}user:${token.userId}`

    const serialized = this.serializeToken(token)

    const pipeline = this.redis.pipeline()
    pipeline.hset(tokenKey, serialized)
    pipeline.set(hashKey, token.id)
    pipeline.sadd(userKey, token.id)

    if (token.expiresAt) {
      const ttl = Math.max(0, token.expiresAt.getTime() - Date.now())
      if (ttl > 0) {
        pipeline.pexpire(tokenKey, ttl)
        pipeline.pexpire(hashKey, ttl)
      }
    }

    await pipeline.exec()
  }

  async findByHashedToken(hashedToken: string): Promise<ApiToken | null> {
    const hashKey = `${this.prefix}hash:${hashedToken}`
    const tokenId = await this.redis.get(hashKey)

    if (!tokenId) {
      return null
    }

    return this.findById(tokenId)
  }

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

  async deleteForUser(userId: string | number): Promise<void> {
    const tokens = await this.findByUserId(userId)

    for (const token of tokens) {
      await this.delete(token.id)
    }

    const userKey = `${this.prefix}user:${userId}`
    await this.redis.del(userKey)
  }

  async updateLastUsed(id: string, timestamp: Date): Promise<void> {
    const tokenKey = `${this.prefix}${id}`
    await this.redis.hset(tokenKey, 'lastUsedAt', timestamp.toISOString())
  }

  private async findById(id: string): Promise<ApiToken | null> {
    const tokenKey = `${this.prefix}${id}`
    const data = await this.redis.hgetall(tokenKey)

    if (!data || Object.keys(data).length === 0) {
      return null
    }

    return this.deserializeToken(data)
  }

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

  private deserializeToken(data: Record<string, string>): ApiToken {
    return {
      id: data.id,
      name: data.name,
      hashedToken: data.hashedToken,
      userId: data.userId,
      abilities: decodeAbilities(data.abilities),
      lastUsedAt: toDate(data.lastUsedAt),
      // A Redis hash has no null, so a never-expiring token stores '' — absent,
      // not corrupt. `toOptionalExpiry` would degrade '' to epoch and reject
      // every non-expiring token; a truly unparseable value still does.
      expiresAt: toOptionalExpiry(data.expiresAt === '' ? undefined : data.expiresAt),
      createdAt: toDate(data.createdAt) ?? new Date(0),
    }
  }

  /** Testing only. */
  async clear(): Promise<void> {
    const keys = await scanKeys(this.redis, this.prefix + '*')
    if (keys.length > 0) {
      await this.redis.del(...keys)
    }
  }
}
