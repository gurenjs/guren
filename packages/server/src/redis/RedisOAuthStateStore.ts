import type { Redis } from 'ioredis'
import type { OAuthStatePayload, OAuthStateStore } from '../auth/oauth'
import { scanKeys } from './scan-keys'

/**
 * Options for RedisOAuthStateStore.
 */
export interface RedisOAuthStateStoreOptions {
  /**
   * Key prefix for OAuth state keys.
   * @default 'oauthstate:'
   */
  prefix?: string
}

/**
 * Redis-backed OAuth state store.
 *
 * Required in production whenever more than one server process handles
 * traffic (load balancers, serverless): the default MemoryOAuthStateStore
 * is per-process, so the callback request may land on a process that never
 * saw the state. Entries expire automatically via Redis TTL.
 *
 * @example
 * ```ts
 * import { createOAuthManager } from '@guren/core'
 * import { createRedisClient, RedisOAuthStateStore } from '@guren/core/redis'
 *
 * const redis = createRedisClient({ url: process.env.REDIS_URL })
 * const oauth = createOAuthManager({ stateStore: new RedisOAuthStateStore(redis) })
 * ```
 */
// GET + DEL in one script so consumption is atomic on the Redis side.
// GETDEL would do the same but requires Redis >= 6.2; EVAL works everywhere.
const CONSUME_SCRIPT = `
local value = redis.call('GET', KEYS[1])
if value then
  redis.call('DEL', KEYS[1])
end
return value
`

export class RedisOAuthStateStore implements OAuthStateStore {
  private readonly prefix: string

  constructor(
    private readonly redis: Redis,
    options: RedisOAuthStateStoreOptions = {},
  ) {
    this.prefix = options.prefix ?? 'oauthstate:'
  }

  async store(stateHash: string, payload: OAuthStatePayload): Promise<void> {
    const ttlMs = Math.max(0, payload.expiresAt.getTime() - Date.now())
    if (ttlMs <= 0) {
      return
    }

    const data = JSON.stringify({
      provider: payload.provider,
      redirectTo: payload.redirectTo,
      expiresAt: payload.expiresAt.toISOString(),
    })

    await this.redis.psetex(`${this.prefix}${stateHash}`, ttlMs, data)
  }

  async find(stateHash: string): Promise<OAuthStatePayload | null> {
    const data = await this.redis.get(`${this.prefix}${stateHash}`)
    if (!data) {
      return null
    }

    const payload = this.parsePayload(data)
    if (!payload) {
      return null
    }
    if (payload.expiresAt.getTime() <= Date.now()) {
      await this.delete(stateHash)
      return null
    }
    return payload
  }

  async consume(stateHash: string): Promise<OAuthStatePayload | null> {
    const data = (await this.redis.eval(
      CONSUME_SCRIPT,
      1,
      `${this.prefix}${stateHash}`,
    )) as string | null
    if (!data) {
      return null
    }

    const payload = this.parsePayload(data)
    if (!payload || payload.expiresAt.getTime() <= Date.now()) {
      return null
    }
    return payload
  }

  private parsePayload(data: string): OAuthStatePayload | null {
    try {
      const parsed = JSON.parse(data) as { provider: string; redirectTo?: string; expiresAt: string }
      return {
        provider: parsed.provider,
        redirectTo: parsed.redirectTo,
        expiresAt: new Date(parsed.expiresAt),
      }
    } catch {
      return null
    }
  }

  async delete(stateHash: string): Promise<void> {
    await this.redis.del(`${this.prefix}${stateHash}`)
  }

  /**
   * Clear all states (for testing).
   */
  async clear(): Promise<void> {
    const keys = await scanKeys(this.redis, this.prefix + '*')
    if (keys.length > 0) {
      await this.redis.del(...keys)
    }
  }
}
