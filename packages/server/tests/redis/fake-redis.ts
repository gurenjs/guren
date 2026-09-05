import type { Redis } from 'ioredis'
import { INCREMENT_SCRIPT, SLIDING_WINDOW_SCRIPT } from '../../src/redis/RedisRateLimitStore'

/**
 * In-memory stand-in for the string/set/pipeline commands of the password-reset and
 * email-verification stores, the sorted-set/expiry commands, and the two Lua scripts the
 * rate limit stores `eval`. Atomicity is modelled: `eval` applies a script synchronously,
 * `pipeline().exec()` awaits between queued commands so two callers interleave inside it,
 * as real Redis permits. The Lua itself is proven only by RedisStores.test.ts (REDIS_URL).
 */
export class FakeRedis {
  private readonly strings = new Map<string, string>()
  private readonly sets = new Map<string, Set<string>>()
  /** member → score */
  private readonly zsets = new Map<string, Map<string, number>>()
  /** key → absolute expiry (ms since epoch); absent means no TTL */
  private readonly expiries = new Map<string, number>()

  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null
  }

  async set(key: string, value: string): Promise<'OK'> {
    this.strings.set(key, value)
    return 'OK'
  }

  async psetex(key: string, _ttlMs: number, value: string): Promise<'OK'> {
    this.strings.set(key, value)
    return 'OK'
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0
    for (const key of keys) {
      const hadString = this.strings.delete(key)
      const hadSet = this.sets.delete(key)
      const hadZset = this.zsets.delete(key)
      this.expiries.delete(key)
      if (hadString || hadSet || hadZset) removed++
    }
    return removed
  }

  async sadd(key: string, member: string): Promise<number> {
    const set = this.sets.get(key) ?? new Set<string>()
    const before = set.size
    set.add(member)
    this.sets.set(key, set)
    return set.size - before
  }

  async srem(key: string, member: string): Promise<number> {
    return this.sets.get(key)?.delete(member) ? 1 : 0
  }

  async smembers(key: string): Promise<string[]> {
    return Array.from(this.sets.get(key) ?? [])
  }

  async pexpire(key: string, ttlMs: number): Promise<number> {
    return this.pexpireSync(key, ttlMs)
  }

  async pttl(key: string): Promise<number> {
    return this.pttlSync(key)
  }

  async zcard(key: string): Promise<number> {
    return this.zsets.get(key)?.size ?? 0
  }

  /**
   * Runs one of the rate limit scripts. The body is deliberately free of
   * `await`: a fake that yielded between the script's steps would let a
   * second caller race inside the section Redis guarantees is atomic.
   */
  async eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown> {
    const keys = args.slice(0, numKeys).map(String)
    const argv = args.slice(numKeys).map(String)
    switch (script) {
      case INCREMENT_SCRIPT:
        return this.runIncrementScript(keys[0], argv)
      case SLIDING_WINDOW_SCRIPT:
        return this.runSlidingWindowScript(keys[0], argv)
      default:
        throw new Error('FakeRedis.eval: script not covered by this fake')
    }
  }

  private runIncrementScript(key: string, [windowMs, now]: string[]): [number, number] {
    const count = Number(this.strings.get(key) ?? '0') + 1
    this.strings.set(key, String(count))
    if (count === 1) this.pexpireSync(key, Number(windowMs))
    return [count, Number(now) + this.pttlSync(key)]
  }

  private runSlidingWindowScript(key: string, [windowMs, now, member]: string[]): number {
    const zset = this.zsets.get(key) ?? new Map<string, number>()
    const windowStart = Number(now) - Number(windowMs)
    for (const [m, score] of zset) {
      if (score <= windowStart) zset.delete(m)
    }
    zset.set(member, Number(now))
    this.zsets.set(key, zset)
    this.pexpireSync(key, Number(windowMs))
    return zset.size
  }

  private exists(key: string): boolean {
    return this.strings.has(key) || this.sets.has(key) || this.zsets.has(key)
  }

  private pexpireSync(key: string, ttlMs: number): number {
    if (!this.exists(key)) return 0
    this.expiries.set(key, Date.now() + ttlMs)
    return 1
  }

  private pttlSync(key: string): number {
    if (!this.exists(key)) return -2
    const expiresAt = this.expiries.get(key)
    return expiresAt === undefined ? -1 : Math.max(0, expiresAt - Date.now())
  }

  pipeline() {
    const queued: Array<() => Promise<unknown>> = []
    const chain = {
      psetex: (...args: Parameters<FakeRedis['psetex']>) => {
        queued.push(() => this.psetex(...args))
        return chain
      },
      sadd: (...args: Parameters<FakeRedis['sadd']>) => {
        queued.push(() => this.sadd(...args))
        return chain
      },
      srem: (...args: Parameters<FakeRedis['srem']>) => {
        queued.push(() => this.srem(...args))
        return chain
      },
      pexpire: (...args: Parameters<FakeRedis['pexpire']>) => {
        queued.push(() => this.pexpire(...args))
        return chain
      },
      del: (...args: string[]) => {
        queued.push(() => this.del(...args))
        return chain
      },
      exec: async () => {
        for (const run of queued) await run()
        return []
      },
    }
    return chain
  }
}

/** Cast helper so call sites don't repeat `as unknown as Redis`. */
export function asRedis(fake: FakeRedis): Redis {
  return fake as unknown as Redis
}
