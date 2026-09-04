import { describe, expect, it } from 'bun:test'
import type { Redis } from 'ioredis'
import { RedisOAuthStateStore } from '../../src/redis/RedisOAuthStateStore'

/** eval mirrors the real GET+DEL script: read and delete are one atomic step. */
class FakeRedis {
  private readonly data = new Map<string, string>()

  async psetex(key: string, _ttlMs: number, value: string): Promise<'OK'> {
    this.data.set(key, value)
    return 'OK'
  }

  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0
    for (const key of keys) {
      if (this.data.delete(key)) removed++
    }
    return removed
  }

  async eval(_script: string, _numKeys: number, key: string): Promise<string | null> {
    const value = this.data.get(key) ?? null
    if (value !== null) {
      this.data.delete(key)
    }
    return value
  }
}

const createStore = () => {
  const redis = new FakeRedis()
  return new RedisOAuthStateStore(redis as unknown as Redis, { prefix: 'test:oauthstate:' })
}

describe('RedisOAuthStateStore', () => {
  it('consume returns the payload once and deletes the key', async () => {
    const store = createStore()
    const expiresAt = new Date(Date.now() + 60_000)
    await store.store('hash-1', { provider: 'github', redirectTo: '/dashboard', expiresAt })

    const first = await store.consume('hash-1')
    expect(first).not.toBeNull()
    expect(first!.provider).toBe('github')
    expect(first!.redirectTo).toBe('/dashboard')
    expect(first!.expiresAt.getTime()).toBe(expiresAt.getTime())

    expect(await store.consume('hash-1')).toBeNull()
    expect(await store.find('hash-1')).toBeNull()
  })

  // A store that drops the binding hands back an unbound state, which then
  // verifies for any browser — silently undoing the login-CSRF fix.
  it('round-trips the browser binding', async () => {
    const store = createStore()
    await store.store('hash-bound', {
      provider: 'github',
      expiresAt: new Date(Date.now() + 60_000),
      binding: 'hashed-binding',
    })

    expect((await store.find('hash-bound'))!.binding).toBe('hashed-binding')
    expect((await store.consume('hash-bound'))!.binding).toBe('hashed-binding')
  })

  it('consume returns null for an unknown state hash', async () => {
    const store = createStore()
    expect(await store.consume('missing')).toBeNull()
  })

  it('consume returns null for an expired payload', async () => {
    // The embedded expiry has lapsed while the Redis TTL has not fired yet.
    const redis = new FakeRedis()
    const store = new RedisOAuthStateStore(redis as unknown as Redis)
    await redis.psetex(
      'oauthstate:hash-expired',
      60_000,
      JSON.stringify({
        provider: 'github',
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      }),
    )

    expect(await store.consume('hash-expired')).toBeNull()
    expect(await redis.get('oauthstate:hash-expired')).toBeNull()
  })

  // A corrupt expiry compares false against Date.now(), so it would read as
  // never expiring and hand back a live state. Must fail closed.
  it('treats an unparseable expiry as expired', async () => {
    const redis = new FakeRedis()
    const store = new RedisOAuthStateStore(redis as unknown as Redis)
    const corrupt = JSON.stringify({ provider: 'github', expiresAt: 'not-a-date' })
    await redis.psetex('oauthstate:hash-corrupt', 60_000, corrupt)

    // Order matters: `consume` deletes, so it must run after `find`.
    expect(await store.find('hash-corrupt')).toBeNull()
    expect(await store.consume('hash-corrupt')).toBeNull()
  })

  it('concurrent consume hands the payload to exactly one caller', async () => {
    const store = createStore()
    await store.store('hash-race', {
      provider: 'github',
      expiresAt: new Date(Date.now() + 60_000),
    })

    const results = await Promise.all([
      store.consume('hash-race'),
      store.consume('hash-race'),
      store.consume('hash-race'),
    ])

    expect(results.filter((r) => r !== null)).toHaveLength(1)
  })
})
