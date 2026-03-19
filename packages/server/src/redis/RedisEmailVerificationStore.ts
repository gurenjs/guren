import type { Redis } from 'ioredis'
import type {
  EmailVerificationTokenStore,
  EmailVerificationToken,
} from '../auth/email-verification'

/**
 * Options for RedisEmailVerificationStore.
 */
export interface RedisEmailVerificationStoreOptions {
  /**
   * Key prefix for email verification keys.
   * @default 'emailverify:'
   */
  prefix?: string
}

/**
 * Redis-backed email verification token store.
 *
 * Uses the following key structure:
 * - `emailverify:{hashedToken}` - Token data (JSON)
 * - `emailverify:email:{email}` - Set of hashed tokens for an email
 *
 * @example
 * ```ts
 * import { createRedisClient } from '@guren/server/redis'
 *
 * const redis = createRedisClient({ url: process.env.REDIS_URL })
 * const store = new RedisEmailVerificationStore(redis)
 *
 * const { token } = await createEmailVerificationToken(email, store, { expiresIn: 86400000 })
 * ```
 */
export class RedisEmailVerificationStore implements EmailVerificationTokenStore {
  private readonly prefix: string

  constructor(
    private readonly redis: Redis,
    options: RedisEmailVerificationStoreOptions = {}
  ) {
    this.prefix = options.prefix ?? 'emailverify:'
  }

  /**
   * Store an email verification token.
   */
  async store(token: EmailVerificationToken): Promise<void> {
    const tokenKey = `${this.prefix}${token.hashedToken}`
    const emailKey = `${this.prefix}email:${token.email.toLowerCase()}`
    const ttlMs = Math.max(0, token.expiresAt.getTime() - Date.now())

    if (ttlMs <= 0) {
      return // Token already expired
    }

    const data = JSON.stringify({
      hashedToken: token.hashedToken,
      email: token.email,
      expiresAt: token.expiresAt.toISOString(),
      createdAt: token.createdAt.toISOString(),
    })

    const pipeline = this.redis.pipeline()
    pipeline.psetex(tokenKey, ttlMs, data)
    pipeline.sadd(emailKey, token.hashedToken)
    pipeline.pexpire(emailKey, ttlMs + 60000) // Add buffer to email set expiration
    await pipeline.exec()
  }

  /**
   * Find a token by its hash.
   */
  async findByHashedToken(hashedToken: string): Promise<EmailVerificationToken | null> {
    const tokenKey = `${this.prefix}${hashedToken}`
    const data = await this.redis.get(tokenKey)

    if (!data) {
      return null
    }

    try {
      const parsed = JSON.parse(data) as {
        hashedToken: string
        email: string
        expiresAt: string
        createdAt: string
      }
      return {
        hashedToken: parsed.hashedToken,
        email: parsed.email,
        expiresAt: new Date(parsed.expiresAt),
        createdAt: new Date(parsed.createdAt),
      }
    } catch {
      return null
    }
  }

  /**
   * Delete a token by its hash.
   */
  async delete(hashedToken: string): Promise<void> {
    const tokenKey = `${this.prefix}${hashedToken}`
    const data = await this.redis.get(tokenKey)

    if (data) {
      try {
        const parsed = JSON.parse(data) as { email: string }
        const emailKey = `${this.prefix}email:${parsed.email.toLowerCase()}`
        await this.redis.srem(emailKey, hashedToken)
      } catch {
        // Ignore parse errors
      }
    }

    await this.redis.del(tokenKey)
  }

  /**
   * Delete all tokens for an email.
   */
  async deleteForEmail(email: string): Promise<void> {
    const emailKey = `${this.prefix}email:${email.toLowerCase()}`
    const tokenHashes = await this.redis.smembers(emailKey)

    if (tokenHashes.length > 0) {
      const tokenKeys = tokenHashes.map((hash) => `${this.prefix}${hash}`)
      await this.redis.del(...tokenKeys, emailKey)
    } else {
      await this.redis.del(emailKey)
    }
  }

  /**
   * Clear all tokens (for testing).
   */
  async clear(): Promise<void> {
    const pattern = this.prefix + '*'
    const keys: string[] = []
    let cursor = '0'

    do {
      const [newCursor, foundKeys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
      cursor = newCursor
      keys.push(...foundKeys)
    } while (cursor !== '0')

    if (keys.length > 0) {
      await this.redis.del(...keys)
    }
  }
}
