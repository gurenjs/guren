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

  // A corrupt expiry parses to an Invalid Date, and every comparison against
  // one is false — the record would read as never expired instead of refused.
  it('returns null when the stored expiry is unparseable', async () => {
    const redis = new FakeRedis()
    const store = new RedisPasswordResetStore(asRedis(redis))
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
