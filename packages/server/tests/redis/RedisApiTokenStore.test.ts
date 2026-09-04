import { describe, expect, it } from 'bun:test'
import type { Redis } from 'ioredis'
import { RedisApiTokenStore } from '../../src/redis/RedisApiTokenStore'
import { tokenCan, verifyApiToken } from '../../src/auth/api-token'
import { generateToken, hashToken } from '../../src/auth/utils'

/** Hash values are strings, exactly as a real Redis hash returns them. */
class FakeRedis {
  private readonly strings = new Map<string, string>()
  private readonly hashes = new Map<string, Record<string, string>>()
  private readonly sets = new Map<string, Set<string>>()

  async hset(key: string, fieldOrValues: string | Record<string, string>, value?: string) {
    const hash = this.hashes.get(key) ?? {}
    if (typeof fieldOrValues === 'string') {
      hash[fieldOrValues] = value as string
    } else {
      Object.assign(hash, fieldOrValues)
    }
    this.hashes.set(key, hash)
    return 1
  }

  // Real hgetall answers a missing key with an empty hash, not null.
  async hgetall(key: string): Promise<Record<string, string>> {
    return { ...this.hashes.get(key) }
  }

  async set(key: string, value: string) {
    this.strings.set(key, value)
    return 'OK' as const
  }

  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null
  }

  async sadd(key: string, member: string) {
    const set = this.sets.get(key) ?? new Set<string>()
    set.add(member)
    this.sets.set(key, set)
    return 1
  }

  async srem(key: string, member: string) {
    return this.sets.get(key)?.delete(member) ? 1 : 0
  }

  async smembers(key: string): Promise<string[]> {
    return Array.from(this.sets.get(key) ?? [])
  }

  async del(...keys: string[]) {
    let removed = 0
    for (const key of keys) {
      if (this.strings.delete(key) || this.hashes.delete(key) || this.sets.delete(key)) removed++
    }
    return removed
  }

  async pexpire(_key: string, _ttl: number) {
    return 1
  }

  pipeline() {
    const queued: Array<() => Promise<unknown>> = []
    const chain = {
      hset: (...args: Parameters<FakeRedis['hset']>) => {
        queued.push(() => this.hset(...args))
        return chain
      },
      set: (...args: Parameters<FakeRedis['set']>) => {
        queued.push(() => this.set(...args))
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
      del: (...args: string[]) => {
        queued.push(() => this.del(...args))
        return chain
      },
      pexpire: (...args: Parameters<FakeRedis['pexpire']>) => {
        queued.push(() => this.pexpire(...args))
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

const PREFIX = 'apitoken:'

/** Bypasses `store()` to write records a healthy `store()` could never produce. */
async function seedToken(
  redis: FakeRedis,
  overrides: Record<string, string> = {},
): Promise<{ id: string; hashedToken: string; plainTextToken: string }> {
  const id = 'token-1'
  const plainToken = generateToken(16)
  const hashedToken = hashToken(plainToken)

  await redis.hset(`${PREFIX}${id}`, {
    id,
    name: 'Test Token',
    hashedToken,
    userId: '42',
    abilities: JSON.stringify(['read']),
    lastUsedAt: '',
    expiresAt: '',
    createdAt: new Date().toISOString(),
    ...overrides,
  })
  await redis.set(`${PREFIX}hash:${hashedToken}`, id)

  return { id, hashedToken, plainTextToken: `${id}|${plainToken}` }
}

describe('RedisApiTokenStore', () => {
  it('round-trips a stored token', async () => {
    const redis = new FakeRedis()
    const store = new RedisApiTokenStore(redis as unknown as Redis)
    const expiresAt = new Date(Date.now() + 60_000)

    await store.store({
      id: 'abc',
      name: 'Mobile',
      hashedToken: 'hashed',
      userId: '7',
      abilities: ['posts:read'],
      lastUsedAt: null,
      expiresAt,
      createdAt: new Date(),
    })

    const found = await store.findByHashedToken('hashed')
    expect(found).not.toBeNull()
    expect(found!.abilities).toEqual(['posts:read'])
    expect(found!.expiresAt!.getTime()).toBe(expiresAt.getTime())
    expect(found!.lastUsedAt).toBeNull()
  })

  // One corrupt record must not 500 every verification of that token: the
  // database sibling degrades to no abilities, and so must this one.
  it('degrades unparseable abilities to no abilities instead of throwing', async () => {
    const redis = new FakeRedis()
    const store = new RedisApiTokenStore(redis as unknown as Redis)
    const { hashedToken } = await seedToken(redis, { abilities: 'not json' })

    const token = await store.findByHashedToken(hashedToken)
    expect(token).not.toBeNull()
    expect(token!.abilities).toEqual([])
  })

  // A JSON scalar parses to the *string* `"*"`, and `tokenCan` then runs
  // `String.prototype.includes` on it — so `"*".includes(anything)` would
  // grant every ability on the system.
  it('does not grant every ability when abilities decode to a bare string', async () => {
    const redis = new FakeRedis()
    const store = new RedisApiTokenStore(redis as unknown as Redis)
    const { hashedToken } = await seedToken(redis, { abilities: '"*"' })

    const token = await store.findByHashedToken(hashedToken)
    expect(token!.abilities).toEqual([])
    expect(tokenCan(token!, 'posts:delete')).toBe(false)
  })

  it('drops non-string entries from a mixed abilities array', async () => {
    const redis = new FakeRedis()
    const store = new RedisApiTokenStore(redis as unknown as Redis)
    const { hashedToken } = await seedToken(redis, {
      abilities: JSON.stringify(['read', 42, null, 'write']),
    })

    const token = await store.findByHashedToken(hashedToken)
    expect(token!.abilities).toEqual(['read', 'write'])
  })

  // `new Date('garbage')` is an Invalid Date, and `new Date() > InvalidDate`
  // is false — verifyApiToken's expiry check would pass a corrupt record
  // straight through, making it an immortal token.
  it('refuses to authenticate a token whose stored expiry is unparseable', async () => {
    const redis = new FakeRedis()
    const store = new RedisApiTokenStore(redis as unknown as Redis)
    const { plainTextToken } = await seedToken(redis, { expiresAt: 'garbage' })

    expect(await verifyApiToken(plainTextToken, store)).toBeNull()
  })

  it('still authenticates a token with a valid future expiry', async () => {
    const redis = new FakeRedis()
    const store = new RedisApiTokenStore(redis as unknown as Redis)
    const { plainTextToken } = await seedToken(redis, {
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })

    const result = await verifyApiToken(plainTextToken, store)
    expect(result).not.toBeNull()
    expect(result!.userId).toBe('42')
  })

  // A never-expiring token serializes `expiresAt` as '' (a Redis hash has no
  // null). That empty string must read as "no expiry", not degrade to epoch —
  // otherwise every non-expiring token in Redis is rejected as expired.
  it('authenticates a token with no expiry stored as an empty string', async () => {
    const redis = new FakeRedis()
    const store = new RedisApiTokenStore(redis as unknown as Redis)
    const { plainTextToken } = await seedToken(redis, { expiresAt: '' })

    const result = await verifyApiToken(plainTextToken, store)
    expect(result).not.toBeNull()
    expect(result!.token.expiresAt).toBeNull()
  })
})
