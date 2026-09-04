import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import {
  RedisRateLimitStore,
  RedisSlidingWindowRateLimitStore,
} from '../../src/redis/RedisRateLimitStore'
import { FakeRedis, asRedis } from './fake-redis'

const WINDOW = 60_000

// Two callers whose commands reach Redis interleaved. With separate round
// trips (or a pipeline, which only batches them) both can insert before either
// counts and both read the same total; an atomic script hands out 1 then 2.
describe('RedisSlidingWindowRateLimitStore', () => {
  afterEach(() => {
    spyOn(Date, 'now').mockRestore()
  })

  it('gives interleaved callers distinct consecutive counts', async () => {
    const redis = new FakeRedis()
    const store = new RedisSlidingWindowRateLimitStore(asRedis(redis), { prefix: 'sw:' })

    const entries = await Promise.all([
      store.increment('client', WINDOW),
      store.increment('client', WINDOW),
    ])

    expect(entries.map((e) => e.count).sort()).toEqual([1, 2])
    expect(await store.get('client')).toMatchObject({ count: 2 })
  })

  it('drops entries that fell out of the window before counting', async () => {
    const redis = new FakeRedis()
    const store = new RedisSlidingWindowRateLimitStore(asRedis(redis), { prefix: 'sw:' })
    const now = spyOn(Date, 'now')

    now.mockReturnValue(1_000_000)
    await store.increment('client', 1_000)
    await store.increment('client', 1_000)

    now.mockReturnValue(1_001_500)
    const entry = await store.increment('client', 1_000)

    expect(entry.count).toBe(1)
    expect(entry.resetAt).toBe(1_002_500)
  })
})

describe('RedisRateLimitStore', () => {
  afterEach(() => {
    spyOn(Date, 'now').mockRestore()
  })

  it('gives interleaved callers distinct consecutive counts', async () => {
    const redis = new FakeRedis()
    const store = new RedisRateLimitStore(asRedis(redis), { prefix: 'fw:' })

    const entries = await Promise.all([
      store.increment('client', WINDOW),
      store.increment('client', WINDOW),
    ])

    expect(entries.map((e) => e.count).sort()).toEqual([1, 2])
    expect(await store.get('client')).toMatchObject({ count: 2 })
  })

  it('starts the window on the first hit only', async () => {
    const redis = new FakeRedis()
    const store = new RedisRateLimitStore(asRedis(redis), { prefix: 'fw:' })
    const now = spyOn(Date, 'now')

    now.mockReturnValue(1_000_000)
    const first = await store.increment('client', WINDOW)

    now.mockReturnValue(1_010_000)
    const second = await store.increment('client', WINDOW)

    expect(first.resetAt).toBe(1_060_000)
    expect(second.resetAt).toBe(1_060_000)
  })
})
