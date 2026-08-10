import { describe, expect, it } from 'bun:test'
import { RedisPasswordResetStore } from '../../src/redis/RedisPasswordResetStore'
import { FakeRedis, asRedis } from './fake-redis'

const PREFIX = 'pwreset:'

describe('RedisPasswordResetStore', () => {
  it('round-trips a stored token', async () => {
    const redis = new FakeRedis()
    const store = new RedisPasswordResetStore(asRedis(redis))
    const expiresAt = new Date(Date.now() + 60_000)

    await store.store('token-1', 'user@example.com', expiresAt)

    const found = await store.find('token-1')
    expect(found).not.toBeNull()
    expect(found!.email).toBe('user@example.com')
    expect(found!.expiresAt.getTime()).toBe(expiresAt.getTime())
  })

  // `new Date(parsed.expiresAt)` on a corrupt string is an Invalid Date, and
  // every comparison against one is false — a caller checking `expiresAt <
  // new Date()` would read the record as never expired instead of refusing it.
  it('returns null when the stored expiry is unparseable', async () => {
    const redis = new FakeRedis()
    const store = new RedisPasswordResetStore(asRedis(redis))
    // Bypass store(): a healthy store() always writes a valid ISO string, so
    // this simulates a row corrupted some other way (manual edit, driver bug).
    await redis.set(
      `${PREFIX}token-corrupt`,
      JSON.stringify({ email: 'user@example.com', expiresAt: 'not-a-date' }),
    )

    expect(await store.find('token-corrupt')).toBeNull()
  })

  it('returns null for a missing token', async () => {
    const redis = new FakeRedis()
    const store = new RedisPasswordResetStore(asRedis(redis))

    expect(await store.find('missing')).toBeNull()
  })
})
