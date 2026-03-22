import type { Redis } from 'ioredis'
import type { PasswordResetTokenStore } from '../auth/password-reset'
import { scanKeys } from './scan-keys'

/**
 * Options for RedisPasswordResetStore.
 */
export interface RedisPasswordResetStoreOptions {
  /**
   * Key prefix for password reset keys.
   * @default 'pwreset:'
   */
  prefix?: string
}

/**
 * Redis-backed password reset token store.
 *
 * Uses the following key structure:
 * - `pwreset:{hashedToken}` - Token data (JSON with email and expiresAt)
 * - `pwreset:email:{email}` - Set of hashed tokens for an email
 *
 * @example
 * ```ts
 * import { createRedisClient } from '@guren/server/redis'
 *
 * const redis = createRedisClient({ url: process.env.REDIS_URL })
 * const store = new RedisPasswordResetStore(redis)
 *
 * const { token } = await createPasswordResetToken(email, store, { expiresIn: 3600000 })
 * ```
 */
export class RedisPasswordResetStore implements PasswordResetTokenStore {
  private readonly prefix: string

  constructor(
    private readonly redis: Redis,
    options: RedisPasswordResetStoreOptions = {}
  ) {
    this.prefix = options.prefix ?? 'pwreset:'
  }

  /**
   * Store a password reset token.
   */
  async store(tokenHash: string, email: string, expiresAt: Date): Promise<void> {
    const tokenKey = `${this.prefix}${tokenHash}`
    const emailKey = `${this.prefix}email:${email.toLowerCase()}`
    const ttlMs = Math.max(0, expiresAt.getTime() - Date.now())

    if (ttlMs <= 0) {
      return // Token already expired
    }

    const data = JSON.stringify({ email, expiresAt: expiresAt.toISOString() })

    const pipeline = this.redis.pipeline()
    pipeline.psetex(tokenKey, ttlMs, data)
    pipeline.sadd(emailKey, tokenHash)
    pipeline.pexpire(emailKey, ttlMs + 60000) // Add buffer to email set expiration
    await pipeline.exec()
  }

  /**
   * Find a token by its hash.
   */
  async find(tokenHash: string): Promise<{ email: string; expiresAt: Date } | null> {
    const tokenKey = `${this.prefix}${tokenHash}`
    const data = await this.redis.get(tokenKey)

    if (!data) {
      return null
    }

    try {
      const parsed = JSON.parse(data) as { email: string; expiresAt: string }
      return {
        email: parsed.email,
        expiresAt: new Date(parsed.expiresAt),
      }
    } catch {
      return null
    }
  }

  /**
   * Delete a token by its hash.
   */
  async delete(tokenHash: string): Promise<void> {
    const tokenKey = `${this.prefix}${tokenHash}`
    const data = await this.redis.get(tokenKey)

    if (data) {
      try {
        const parsed = JSON.parse(data) as { email: string }
        const emailKey = `${this.prefix}email:${parsed.email.toLowerCase()}`
        await this.redis.srem(emailKey, tokenHash)
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
    const keys = await scanKeys(this.redis, this.prefix + '*')
    if (keys.length > 0) {
      await this.redis.del(...keys)
    }
  }
}
