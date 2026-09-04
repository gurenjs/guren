import { describe, expect, it } from 'bun:test'
import { RedisEmailVerificationStore } from '../../src/redis/RedisEmailVerificationStore'
import { FakeRedis, asRedis } from './fake-redis'

const PREFIX = 'emailverify:'

describe('RedisEmailVerificationStore', () => {
  it('round-trips a stored token', async () => {
    const redis = new FakeRedis()
    const store = new RedisEmailVerificationStore(asRedis(redis))
    const expiresAt = new Date(Date.now() + 60_000)
    const createdAt = new Date()

    await store.store({ tokenId: 'token-1', email: 'user@example.com', expiresAt, createdAt })

    const found = await store.findByTokenId('token-1')
    expect(found).not.toBeNull()
    expect(found!.email).toBe('user@example.com')
    expect(found!.expiresAt.getTime()).toBe(expiresAt.getTime())
    expect(found!.createdAt.getTime()).toBe(createdAt.getTime())
  })

  // A corrupt expiry parses to an Invalid Date, and every comparison against
  // one is false — the record would read as never expired instead of refused.
  it('returns null when the stored expiry is unparseable', async () => {
    const redis = new FakeRedis()
    const store = new RedisEmailVerificationStore(asRedis(redis))
    await redis.set(
      `${PREFIX}token-corrupt`,
      JSON.stringify({
        tokenId: 'token-corrupt',
        email: 'user@example.com',
        expiresAt: 'not-a-date',
        createdAt: new Date().toISOString(),
      }),
    )

    expect(await store.findByTokenId('token-corrupt')).toBeNull()
  })

  it('degrades an unparseable createdAt instead of throwing, when expiresAt is valid', async () => {
    const redis = new FakeRedis()
    const store = new RedisEmailVerificationStore(asRedis(redis))
    await redis.set(
      `${PREFIX}token-bad-created`,
      JSON.stringify({
        tokenId: 'token-bad-created',
        email: 'user@example.com',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        createdAt: 'not-a-date',
      }),
    )

    const found = await store.findByTokenId('token-bad-created')
    expect(found).not.toBeNull()
    expect(found!.createdAt.getTime()).toBe(0)
  })

  it('returns null for a missing token', async () => {
    const redis = new FakeRedis()
    const store = new RedisEmailVerificationStore(asRedis(redis))

    expect(await store.findByTokenId('missing')).toBeNull()
  })
})
