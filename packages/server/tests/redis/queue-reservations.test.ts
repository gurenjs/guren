import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { createRedisClient, type Redis } from '../../src/redis'
import { RedisDriver } from '../../src/queue/drivers/RedisDriver'
import { Job, enqueueJob, registerJob } from '../../src/queue/Job'
import { Worker } from '../../src/queue/Worker'
import type { QueuedJob } from '../../src/queue/types'

const describeRedis = process.env.REDIS_URL ? describe : describe.skip

describeRedis('Redis queue reservations', () => {
  const prefix = `test:reservations:${randomUUID()}:`
  let redis: Redis
  let driver: RedisDriver
  class ExampleJob extends Job { handle() {} }

  beforeEach(async () => {
    redis ??= createRedisClient({ url: process.env.REDIS_URL })
    driver = new RedisDriver(redis, { prefix, visibilityTimeout: 60 })
    await driver.clear()
    registerJob(ExampleJob)
  })
  afterAll(async () => { await driver?.clear(); await redis?.quit() })

  test('only one concurrent consumer reserves each job', async () => {
    await enqueueJob(driver, ExampleJob, {})
    const jobs = await Promise.all(Array.from({ length: 10 }, () => driver.pop('default')))
    expect(jobs.filter(Boolean)).toHaveLength(1)
    expect(await driver.size('default')).toBe(0)
    expect(await redis.zcard(`${prefix}default:reserved`)).toBe(1)
  })

  test('recovers abandoned reservations and rejects every stale-owner write', async () => {
    await enqueueJob(driver, ExampleJob, {})
    const old = (await driver.pop('default'))!
    // Expire the lease deterministically instead of relying on wall-clock sleeps.
    await redis.zadd(`${prefix}default:reserved`, 0, old.id)
    const current = (await driver.pop('default'))!
    expect(current.id).toBe(old.id)
    expect(current.reservationToken).not.toBe(old.reservationToken)
    expect(await driver.extendReservation(old)).toBe(false)
    await driver.release(old)
    await driver.fail(old, new Error('stale'))
    await driver.delete(old.id, old.reservationToken)
    expect(await redis.hget(`${prefix}job:${old.id}`, 'reservationToken')).toBe(current.reservationToken!)
    expect(await driver.size('default')).toBe(0)
    expect(await driver.getFailedJobs('default')).toHaveLength(0)
    await driver.delete(current.id, current.reservationToken)
    expect(await redis.exists(`${prefix}job:${current.id}`)).toBe(0)
  })

  test('persists attempts through release, failure and retry', async () => {
    const id = await enqueueJob(driver, ExampleJob, { value: 'kept' })
    const first = (await driver.pop('default'))!
    first.attempts = 1
    first.lastError = 'retryable'
    await driver.release(first)
    const second = (await driver.pop('default'))!
    expect(second).toMatchObject({ id, attempts: 1, lastError: 'retryable', payload: { value: 'kept' } })
    second.attempts = 2
    await driver.fail(second, new Error('final'))
    expect((await driver.getFailedJobs('default'))[0]).toMatchObject({ id, attempts: 2, error: 'final' })
    await driver.retryFailedJob(id)
    const retried = (await driver.pop('default'))!
    expect(retried.attempts).toBe(0)
    expect(retried.lastError).toBeUndefined()
    expect(await driver.getFailedJobs('default')).toHaveLength(0)
    // A delayed failed-job cleanup must not delete a job that was already retried.
    await driver.deleteFailedJob(id)
    expect(await redis.exists(`${prefix}job:${id}`)).toBe(1)
  })

  test('renews reservations while a timed-out handler drains, then acknowledges it', async () => {
    const lease = 300
    const renewedPastLease = Promise.withResolvers<void>()
    const drain = Promise.withResolvers<void>()
    class DrainingJob extends Job {
      async handle() { await drain.promise }
    }
    class WatchedDriver extends RedisDriver {
      override async extendReservation(job: QueuedJob) {
        const calledAt = Date.now()
        const owned = await super.extendReservation(job)
        if (owned && job.reservedAt && calledAt > job.reservedAt.getTime() + lease) renewedPastLease.resolve()
        return owned
      }
    }
    // The pop runs a Redis round trip after the renewal it waits on; the lease has to outlast a stall there.
    const leased = new WatchedDriver(redis, { prefix, visibilityTimeout: lease })
    registerJob(DrainingJob)
    const id = await enqueueJob(leased, DrainingJob, {}, { maxAttempts: 1 })
    const worker = new Worker(leased, { timeout: 5, stopWhenEmpty: true })
    const running = worker.start()
    try {
      const deadline = setTimeout(() => renewedPastLease.reject(new Error('no renewal past the first lease within 2000ms')), 2000)
      await renewedPastLease.promise.finally(() => clearTimeout(deadline))
      expect(await leased.pop('default')).toBeNull()
      expect(worker.isRunning()).toBe(true)
    } finally { drain.resolve(); await running }
    expect(await leased.getFailedJobs('default')).toHaveLength(0)
    expect(await redis.exists(`${prefix}job:${id}`)).toBe(0)
  })

  test('reservation uses one server-side operation even when the reply is lost', async () => {
    const id = await enqueueJob(driver, ExampleJob, {})
    // Execute the script, then lose its reply: the state must still be recoverable.
    const send = redis.sendCommand.bind(redis)
    redis.sendCommand = (async (command, stream) => {
      const reply = await send(command, stream)
      if (command.name === 'evalsha' || command.name === 'eval') throw new Error('reply lost')
      return reply
    }) as typeof redis.sendCommand
    try { await expect(driver.pop('default')).rejects.toThrow('reply lost') }
    finally { redis.sendCommand = send }
    expect(await redis.zcard(`${prefix}default:reserved`)).toBe(1)
    await redis.zadd(`${prefix}default:reserved`, 0, id)
    expect((await driver.pop('default'))?.id).toBe(id)
  })
})
