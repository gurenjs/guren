import type { Redis } from 'ioredis'

/**
 * In-memory stand-in covering the string/set/pipeline commands
 * RedisPasswordResetStore and RedisEmailVerificationStore use
 * (`get`/`set`/`del`/`sadd`/`srem`/`smembers`/`pipeline().psetex/sadd/pexpire`).
 *
 * Shared rather than forked a third time: RedisOAuthStateStore.test.ts has its
 * own fake covering `eval` (its atomic get+delete), and
 * RedisApiTokenStore.test.ts has its own covering `hset`/`hgetall`. Neither
 * store this fake backs uses hashes or Lua, so this is the narrower surface
 * the other two fakes already duplicate a slice of.
 */
export class FakeRedis {
  private readonly strings = new Map<string, string>()
  private readonly sets = new Map<string, Set<string>>()

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
      if (this.strings.delete(key) || this.sets.delete(key)) removed++
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

  async pexpire(_key: string, _ttlMs: number): Promise<number> {
    return 1
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
