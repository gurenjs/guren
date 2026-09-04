import type { Redis } from 'ioredis'
import type { PasswordResetTokenStore } from '../auth/password-reset'
import { scanKeys } from './scan-keys'
import { toDate } from '../support/expiry'

export interface RedisPasswordResetStoreOptions {
  /** @default 'pwreset:' */
  prefix?: string
}

/**
 * Key layout: `pwreset:{tokenId}` JSON of email + expiresAt,
 * `pwreset:email:{email}` Set of an email's token IDs.
 */
export class RedisPasswordResetStore implements PasswordResetTokenStore {
  private readonly prefix: string

  constructor(
    private readonly redis: Redis,
    options: RedisPasswordResetStoreOptions = {}
  ) {
    this.prefix = options.prefix ?? 'pwreset:'
  }

  async store(tokenId: string, email: string, expiresAt: Date): Promise<void> {
    const tokenKey = `${this.prefix}${tokenId}`
    const emailKey = `${this.prefix}email:${email.toLowerCase()}`
    const ttlMs = Math.max(0, expiresAt.getTime() - Date.now())

    if (ttlMs <= 0) {
      return
    }

    const data = JSON.stringify({ email, expiresAt: expiresAt.toISOString() })

    const pipeline = this.redis.pipeline()
    pipeline.psetex(tokenKey, ttlMs, data)
    pipeline.sadd(emailKey, tokenId)
    pipeline.pexpire(emailKey, ttlMs + 60000) // Add buffer to email set expiration
    await pipeline.exec()
  }

  async find(tokenId: string): Promise<{ email: string; expiresAt: Date } | null> {
    const tokenKey = `${this.prefix}${tokenId}`
    const data = await this.redis.get(tokenKey)

    if (!data) {
      return null
    }

    try {
      const parsed = JSON.parse(data) as { email: string; expiresAt: string }
      // Fail closed: an Invalid Date loses every comparison, so a corrupt expiry
      // would read as never expiring.
      const expiresAt = toDate(parsed.expiresAt)
      if (expiresAt === null) {
        return null
      }
      return {
        email: parsed.email,
        expiresAt,
      }
    } catch {
      return null
    }
  }

  async delete(tokenId: string): Promise<void> {
    const tokenKey = `${this.prefix}${tokenId}`
    const data = await this.redis.get(tokenKey)

    if (data) {
      try {
        const parsed = JSON.parse(data) as { email: string }
        const emailKey = `${this.prefix}email:${parsed.email.toLowerCase()}`
        await this.redis.srem(emailKey, tokenId)
      } catch {
        // Ignore parse errors
      }
    }

    await this.redis.del(tokenKey)
  }

  async deleteForEmail(email: string): Promise<void> {
    const emailKey = `${this.prefix}email:${email.toLowerCase()}`
    const tokenIds = await this.redis.smembers(emailKey)

    if (tokenIds.length > 0) {
      const tokenKeys = tokenIds.map((tokenId) => `${this.prefix}${tokenId}`)
      await this.redis.del(...tokenKeys, emailKey)
    } else {
      await this.redis.del(emailKey)
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
