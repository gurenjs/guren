import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import Redis from 'ioredis'
import {
  createRedisClient,
  RedisSessionStore,
  RedisRateLimitStore,
  RedisSlidingWindowRateLimitStore,
  RedisApiTokenStore,
  RedisPasswordResetStore,
  RedisEmailVerificationStore,
} from '../../src/redis'
import { createApiToken } from '../../src/auth/api-token'

const REDIS_URL = process.env.REDIS_URL
const describeRedis = REDIS_URL ? describe : describe.skip

describeRedis('Redis Stores (requires REDIS_URL)', () => {
  let redis: Redis

  beforeAll(() => {
    redis = createRedisClient({ url: REDIS_URL })
  })

  afterAll(async () => {
    await redis.quit()
  })

  describe('createRedisClient', () => {
    it('creates a Redis client', () => {
      expect(redis).toBeInstanceOf(Redis)
    })

    it('can ping Redis', async () => {
      const result = await redis.ping()
      expect(result).toBe('PONG')
    })
  })

  describe('RedisSessionStore', () => {
    let store: RedisSessionStore

    beforeEach(async () => {
      store = new RedisSessionStore(redis, { prefix: 'test:session:' })
      await store.clear()
    })

    it('returns undefined for non-existent session', async () => {
      const data = await store.read('non-existent')
      expect(data).toBeUndefined()
    })

    it('writes and reads session data', async () => {
      await store.write('session-1', { user: 'john', role: 'admin' }, 3600)
      const data = await store.read('session-1')
      expect(data).toEqual({ user: 'john', role: 'admin' })
    })

    it('destroys session', async () => {
      await store.write('session-1', { user: 'john' }, 3600)
      await store.destroy('session-1')
      const data = await store.read('session-1')
      expect(data).toBeUndefined()
    })

    it('respects TTL', async () => {
      // TTL is enforced server-side by Redis (SETEX), so a client clock cannot fake it
      await store.write('session-1', { user: 'john' }, 1) // 1 second TTL
      await new Promise((r) => setTimeout(r, 1500))
      const data = await store.read('session-1')
      expect(data).toBeUndefined()
    })

    it('lists session keys', async () => {
      await store.write('session-1', { user: 'john' }, 3600)
      await store.write('session-2', { user: 'jane' }, 3600)
      const keys = await store.keys()
      expect(keys).toContain('session-1')
      expect(keys).toContain('session-2')
    })

    it('returns correct size', async () => {
      expect(await store.size()).toBe(0)
      await store.write('session-1', { user: 'john' }, 3600)
      expect(await store.size()).toBe(1)
    })

    it('clears all sessions', async () => {
      await store.write('session-1', { user: 'john' }, 3600)
      await store.write('session-2', { user: 'jane' }, 3600)
      await store.clear()
      expect(await store.size()).toBe(0)
    })
  })

  describe('RedisRateLimitStore', () => {
    let store: RedisRateLimitStore

    beforeEach(async () => {
      store = new RedisRateLimitStore(redis, { prefix: 'test:ratelimit:' })
      await store.clear()
    })

    it('returns null for non-existent key', async () => {
      const entry = await store.get('non-existent')
      expect(entry).toBeNull()
    })

    it('increments counter', async () => {
      const entry1 = await store.increment('key-1', 60000)
      expect(entry1.count).toBe(1)

      const entry2 = await store.increment('key-1', 60000)
      expect(entry2.count).toBe(2)
    })

    it('returns entry with resetAt', async () => {
      const entry = await store.increment('key-1', 60000)
      expect(entry.resetAt).toBeGreaterThan(Date.now())
      expect(entry.resetAt).toBeLessThanOrEqual(Date.now() + 60000)
    })

    it('resets counter', async () => {
      await store.increment('key-1', 60000)
      await store.increment('key-1', 60000)
      await store.reset('key-1')
      const entry = await store.get('key-1')
      expect(entry).toBeNull()
    })

    it('expires after window', async () => {
      await store.increment('key-1', 100) // 100ms window
      await new Promise((r) => setTimeout(r, 200))
      const entry = await store.get('key-1')
      expect(entry).toBeNull()
    })
  })

  describe('RedisSlidingWindowRateLimitStore', () => {
    let store: RedisSlidingWindowRateLimitStore

    beforeEach(async () => {
      store = new RedisSlidingWindowRateLimitStore(redis, { prefix: 'test:ratelimit:sw:' })
      await store.clear()
    })

    it('returns null for non-existent key', async () => {
      const entry = await store.get('non-existent')
      expect(entry).toBeNull()
    })

    it('increments counter', async () => {
      const entry1 = await store.increment('key-1', 60000)
      expect(entry1.count).toBe(1)

      const entry2 = await store.increment('key-1', 60000)
      expect(entry2.count).toBe(2)
    })

    it('removes old entries from sliding window', async () => {
      await store.increment('key-1', 100) // 100ms window
      await new Promise((r) => setTimeout(r, 150))
      const entry = await store.increment('key-1', 100)
      expect(entry.count).toBe(1)
    })
  })

  describe('RedisApiTokenStore', () => {
    let store: RedisApiTokenStore

    beforeEach(async () => {
      store = new RedisApiTokenStore(redis, { prefix: 'test:apitoken:' })
      await store.clear()
    })

    it('stores and retrieves token by hash', async () => {
      const { token, plainTextToken } = await createApiToken(store, {
        name: 'Test Token',
        userId: 'user-1',
        abilities: ['read', 'write'],
      })

      const found = await store.findByHashedToken(token.hashedToken)
      expect(found).not.toBeNull()
      expect(found!.name).toBe('Test Token')
      expect(found!.userId).toBe('user-1')
      expect(found!.abilities).toEqual(['read', 'write'])
    })

    it('finds tokens by user ID', async () => {
      await createApiToken(store, { name: 'Token 1', userId: 'user-1' })
      await createApiToken(store, { name: 'Token 2', userId: 'user-1' })
      await createApiToken(store, { name: 'Token 3', userId: 'user-2' })

      const userTokens = await store.findByUserId('user-1')
      expect(userTokens).toHaveLength(2)
      expect(userTokens.map((t) => t.name).sort()).toEqual(['Token 1', 'Token 2'])
    })

    it('deletes token', async () => {
      const { token } = await createApiToken(store, {
        name: 'Test Token',
        userId: 'user-1',
      })

      await store.delete(token.id)

      const found = await store.findByHashedToken(token.hashedToken)
      expect(found).toBeNull()
    })

    it('deletes all tokens for user', async () => {
      await createApiToken(store, { name: 'Token 1', userId: 'user-1' })
      await createApiToken(store, { name: 'Token 2', userId: 'user-1' })
      await createApiToken(store, { name: 'Token 3', userId: 'user-2' })

      await store.deleteForUser('user-1')

      const user1Tokens = await store.findByUserId('user-1')
      const user2Tokens = await store.findByUserId('user-2')

      expect(user1Tokens).toHaveLength(0)
      expect(user2Tokens).toHaveLength(1)
    })

    it('updates last used timestamp', async () => {
      const { token } = await createApiToken(store, {
        name: 'Test Token',
        userId: 'user-1',
      })

      const newTimestamp = new Date()
      await store.updateLastUsed(token.id, newTimestamp)

      const found = await store.findByHashedToken(token.hashedToken)
      expect(found!.lastUsedAt).toEqual(newTimestamp)
    })
  })

  describe('RedisPasswordResetStore', () => {
    let store: RedisPasswordResetStore

    beforeEach(async () => {
      store = new RedisPasswordResetStore(redis, { prefix: 'test:pwreset:' })
      await store.clear()
    })

    it('stores and finds token', async () => {
      const expiresAt = new Date(Date.now() + 3600000)
      await store.store('hash-1', 'user@example.com', expiresAt)

      const found = await store.find('hash-1')
      expect(found).not.toBeNull()
      expect(found!.email).toBe('user@example.com')
    })

    it('returns null for non-existent token', async () => {
      const found = await store.find('non-existent')
      expect(found).toBeNull()
    })

    it('deletes token', async () => {
      const expiresAt = new Date(Date.now() + 3600000)
      await store.store('hash-1', 'user@example.com', expiresAt)

      await store.delete('hash-1')

      const found = await store.find('hash-1')
      expect(found).toBeNull()
    })

    it('deletes all tokens for email', async () => {
      const expiresAt = new Date(Date.now() + 3600000)
      await store.store('hash-1', 'user@example.com', expiresAt)
      await store.store('hash-2', 'user@example.com', expiresAt)
      await store.store('hash-3', 'other@example.com', expiresAt)

      await store.deleteForEmail('user@example.com')

      expect(await store.find('hash-1')).toBeNull()
      expect(await store.find('hash-2')).toBeNull()
      expect(await store.find('hash-3')).not.toBeNull()
    })

    it('expires token after TTL', async () => {
      const expiresAt = new Date(Date.now() + 100)
      await store.store('hash-1', 'user@example.com', expiresAt)

      await new Promise((r) => setTimeout(r, 200))

      const found = await store.find('hash-1')
      expect(found).toBeNull()
    })
  })

  describe('RedisEmailVerificationStore', () => {
    let store: RedisEmailVerificationStore

    beforeEach(async () => {
      store = new RedisEmailVerificationStore(redis, { prefix: 'test:emailverify:' })
      await store.clear()
    })

    it('stores and finds token', async () => {
      const token = {
        tokenId: 'hash-1',
        email: 'user@example.com',
        expiresAt: new Date(Date.now() + 3600000),
        createdAt: new Date(),
      }

      await store.store(token)

      const found = await store.findByTokenId('hash-1')
      expect(found).not.toBeNull()
      expect(found!.email).toBe('user@example.com')
      expect(found!.tokenId).toBe('hash-1')
    })

    it('returns null for non-existent token', async () => {
      const found = await store.findByTokenId('non-existent')
      expect(found).toBeNull()
    })

    it('deletes token', async () => {
      const token = {
        tokenId: 'hash-1',
        email: 'user@example.com',
        expiresAt: new Date(Date.now() + 3600000),
        createdAt: new Date(),
      }

      await store.store(token)
      await store.delete('hash-1')

      const found = await store.findByTokenId('hash-1')
      expect(found).toBeNull()
    })

    it('deletes all tokens for email', async () => {
      const token1 = {
        tokenId: 'hash-1',
        email: 'user@example.com',
        expiresAt: new Date(Date.now() + 3600000),
        createdAt: new Date(),
      }
      const token2 = {
        tokenId: 'hash-2',
        email: 'user@example.com',
        expiresAt: new Date(Date.now() + 3600000),
        createdAt: new Date(),
      }
      const token3 = {
        tokenId: 'hash-3',
        email: 'other@example.com',
        expiresAt: new Date(Date.now() + 3600000),
        createdAt: new Date(),
      }

      await store.store(token1)
      await store.store(token2)
      await store.store(token3)

      await store.deleteForEmail('user@example.com')

      expect(await store.findByTokenId('hash-1')).toBeNull()
      expect(await store.findByTokenId('hash-2')).toBeNull()
      expect(await store.findByTokenId('hash-3')).not.toBeNull()
    })

    it('expires token after TTL', async () => {
      const token = {
        tokenId: 'hash-1',
        email: 'user@example.com',
        expiresAt: new Date(Date.now() + 100),
        createdAt: new Date(),
      }

      await store.store(token)

      await new Promise((r) => setTimeout(r, 200))

      const found = await store.findByTokenId('hash-1')
      expect(found).toBeNull()
    })
  })
})

describe('Redis client options', () => {
  it('createRedisClient returns Redis instance', () => {
    const client = createRedisClient({ host: 'localhost', port: 6379, lazyConnect: true })
    expect(client).toBeDefined()
    client.disconnect()
  })
})

import { RedisDriver } from '../../src/queue/drivers/RedisDriver'
import type { QueuedJob } from '../../src/queue/types'

describeRedis('RedisDriver Queue (requires REDIS_URL)', () => {
  let driver: RedisDriver
  let redis: Redis

  beforeAll(() => {
    redis = createRedisClient({ url: REDIS_URL })
    driver = new RedisDriver(redis, { prefix: 'test:queue:' })
  })

  beforeEach(async () => {
    await driver.clear()
  })

  afterAll(async () => {
    await redis.quit()
  })

  const createJob = (overrides: Partial<QueuedJob> = {}): QueuedJob => ({
    id: `job-${Math.random().toString(36).slice(2)}`,
    name: 'TestJob',
    payload: { data: 'test' },
    queue: 'default',
    attempts: 0,
    maxAttempts: 3,
    availableAt: new Date(),
    createdAt: new Date(),
    reservedAt: null,
    ...overrides,
  })

  it('pushes and pops jobs', async () => {
    const job = createJob()
    await driver.push(job)

    const size = await driver.size('default')
    expect(size).toBe(1)

    const popped = await driver.pop('default')
    expect(popped).not.toBeNull()
    expect(popped!.id).toBe(job.id)
    expect(popped!.name).toBe('TestJob')
  })

  it('returns null when queue is empty', async () => {
    const job = await driver.pop('default')
    expect(job).toBeNull()
  })

  it('respects availableAt time', async () => {
    const futureJob = createJob({
      availableAt: new Date(Date.now() + 60000), // 1 minute in the future
    })

    await driver.push(futureJob)
    const popped = await driver.pop('default')
    expect(popped).toBeNull()
  })

  it('releases jobs back to the queue', async () => {
    const job = createJob()
    await driver.push(job)

    const popped = await driver.pop('default')
    expect(popped).not.toBeNull()

    expect(await driver.size('default')).toBe(0)

    await driver.release(popped!, 0)

    expect(await driver.size('default')).toBe(1)
  })

  it('deletes jobs', async () => {
    const job = createJob()
    await driver.push(job)
    expect(await driver.size('default')).toBe(1)

    await driver.delete(job.id)
    expect(await driver.size('default')).toBe(0)
  })

  it('fails jobs and retrieves them', async () => {
    const job = createJob()
    await driver.push(job)

    const popped = await driver.pop('default')
    expect(popped).not.toBeNull()

    await driver.fail(popped!, new Error('Test error'))

    const failed = await driver.getFailedJobs()
    expect(failed).toHaveLength(1)
    expect(failed[0].error).toBe('Test error')
    expect(failed[0].id).toBe(job.id)
  })

  it('retries failed jobs', async () => {
    const job = createJob()
    await driver.push(job)

    const popped = await driver.pop('default')
    await driver.fail(popped!, new Error('Test error'))

    expect(await driver.size('default')).toBe(0)
    expect((await driver.getFailedJobs()).length).toBe(1)

    await driver.retryFailedJob(job.id)

    expect(await driver.size('default')).toBe(1)
    expect((await driver.getFailedJobs()).length).toBe(0)
  })

  it('deletes failed jobs', async () => {
    const job = createJob()
    await driver.push(job)

    const popped = await driver.pop('default')
    await driver.fail(popped!, new Error('Test error'))

    expect((await driver.getFailedJobs()).length).toBe(1)

    await driver.deleteFailedJob(job.id)

    expect((await driver.getFailedJobs()).length).toBe(0)
  })

  it('clears all jobs', async () => {
    const job1 = createJob()
    const job2 = createJob({ queue: 'high' })

    await driver.push(job1)
    await driver.push(job2)

    expect(await driver.size('default')).toBe(1)
    expect(await driver.size('high')).toBe(1)

    await driver.clear()

    expect(await driver.size('default')).toBe(0)
    expect(await driver.size('high')).toBe(0)
  })
})
