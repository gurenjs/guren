import type { Redis } from 'ioredis'
import type { SchedulerLock } from '../scheduling/types'

export interface RedisSchedulerLockOptions {
  /** @default 'scheduler:' */
  prefix?: string
}

/**
 * `SchedulerLock` shared by every server on one Redis: `SET NX EX` is the whole
 * acquire, so two servers asking for the same tick get one `OK` between them.
 */
export class RedisSchedulerLock implements SchedulerLock {
  private readonly prefix: string

  constructor(
    private readonly redis: Redis,
    options: RedisSchedulerLockOptions = {},
  ) {
    this.prefix = options.prefix ?? 'scheduler:'
  }

  async acquire(key: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.redis.set(this.prefix + key, '1', 'EX', ttlSeconds, 'NX')
    return result === 'OK'
  }

  async release(key: string): Promise<void> {
    await this.redis.del(this.prefix + key)
  }
}
