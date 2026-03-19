import type { Redis } from 'ioredis'
import type { QueueDriver, QueuedJob, FailedJob } from '../types'

/**
 * Options for RedisDriver.
 */
export interface RedisDriverOptions {
  /**
   * Key prefix for queue keys.
   * @default 'queue:'
   */
  prefix?: string

  /**
   * Visibility timeout in milliseconds.
   * Jobs reserved longer than this will be released.
   * @default 60000
   */
  visibilityTimeout?: number
}

/**
 * Redis-backed queue driver for production.
 *
 * Uses the following Redis structures:
 * - `{prefix}{queue}:pending` - Sorted Set (score = availableAt timestamp)
 * - `{prefix}{queue}:reserved` - Sorted Set (score = timeout timestamp)
 * - `{prefix}{queue}:failed` - List of failed job IDs
 * - `{prefix}job:{id}` - Hash containing job data
 *
 * @example
 * ```ts
 * import { createRedisClient } from '@guren/server/redis'
 * import { RedisDriver, setQueueDriver } from '@guren/server/queue'
 *
 * const redis = createRedisClient({ url: process.env.REDIS_URL })
 * const driver = new RedisDriver(redis)
 * setQueueDriver(driver)
 * ```
 */
export class RedisDriver implements QueueDriver {
  private readonly prefix: string
  private readonly visibilityTimeout: number

  constructor(
    private readonly redis: Redis,
    options: RedisDriverOptions = {}
  ) {
    this.prefix = options.prefix ?? 'queue:'
    this.visibilityTimeout = options.visibilityTimeout ?? 60000
  }

  private pendingKey(queue: string): string {
    return `${this.prefix}${queue}:pending`
  }

  private reservedKey(queue: string): string {
    return `${this.prefix}${queue}:reserved`
  }

  private failedKey(queue: string): string {
    return `${this.prefix}${queue}:failed`
  }

  private jobKey(id: string): string {
    return `${this.prefix}job:${id}`
  }

  /**
   * Push a job onto the queue.
   */
  async push(job: QueuedJob): Promise<void> {
    const jobData = {
      id: job.id,
      name: job.name,
      payload: JSON.stringify(job.payload),
      queue: job.queue,
      attempts: String(job.attempts),
      maxAttempts: String(job.maxAttempts),
      availableAt: job.availableAt.toISOString(),
      createdAt: job.createdAt.toISOString(),
    }

    const pipeline = this.redis.pipeline()
    pipeline.hset(this.jobKey(job.id), jobData)
    pipeline.zadd(this.pendingKey(job.queue), job.availableAt.getTime(), job.id)
    await pipeline.exec()
  }

  /**
   * Pop the next available job from the queue.
   */
  async pop(queue: string): Promise<QueuedJob | null> {
    const now = Date.now()

    // First, release any jobs that have exceeded visibility timeout
    await this.releaseTimedOutJobs(queue)

    // Get the next available job
    const jobIds = await this.redis.zrangebyscore(
      this.pendingKey(queue),
      '-inf',
      now,
      'LIMIT',
      0,
      1
    )

    if (jobIds.length === 0) {
      return null
    }

    const jobId = jobIds[0]

    // Move from pending to reserved atomically
    const removed = await this.redis.zrem(this.pendingKey(queue), jobId)
    if (removed === 0) {
      // Another worker got it
      return null
    }

    // Add to reserved set with timeout
    const timeout = now + this.visibilityTimeout
    await this.redis.zadd(this.reservedKey(queue), timeout, jobId)

    // Update job data
    await this.redis.hset(this.jobKey(jobId), 'reservedAt', new Date().toISOString())

    // Fetch job data
    const jobData = await this.redis.hgetall(this.jobKey(jobId))
    if (!jobData || !jobData.id) {
      // Job data missing, remove from reserved
      await this.redis.zrem(this.reservedKey(queue), jobId)
      return null
    }

    return this.parseJobData(jobData)
  }

  /**
   * Release jobs that have exceeded visibility timeout.
   */
  private async releaseTimedOutJobs(queue: string): Promise<void> {
    const now = Date.now()

    // Get timed out jobs
    const timedOutIds = await this.redis.zrangebyscore(
      this.reservedKey(queue),
      '-inf',
      now
    )

    for (const jobId of timedOutIds) {
      // Move back to pending
      const removed = await this.redis.zrem(this.reservedKey(queue), jobId)
      if (removed > 0) {
        await this.redis.zadd(this.pendingKey(queue), now, jobId)
        await this.redis.hdel(this.jobKey(jobId), 'reservedAt')
      }
    }
  }

  /**
   * Release a job back onto the queue.
   */
  async release(job: QueuedJob, delayMs: number = 0): Promise<void> {
    const availableAt = Date.now() + delayMs

    // Remove from reserved
    await this.redis.zrem(this.reservedKey(job.queue), job.id)

    // Update job data
    const updates: Record<string, string> = {
      attempts: String(job.attempts),
      availableAt: new Date(availableAt).toISOString(),
    }
    if (job.lastError) {
      updates.lastError = job.lastError
    }
    await this.redis.hset(this.jobKey(job.id), updates)
    await this.redis.hdel(this.jobKey(job.id), 'reservedAt')

    // Add back to pending
    await this.redis.zadd(this.pendingKey(job.queue), availableAt, job.id)
  }

  /**
   * Delete a job from the queue.
   */
  async delete(jobId: string): Promise<void> {
    const jobData = await this.redis.hgetall(this.jobKey(jobId))
    if (jobData && jobData.queue) {
      const pipeline = this.redis.pipeline()
      pipeline.zrem(this.pendingKey(jobData.queue), jobId)
      pipeline.zrem(this.reservedKey(jobData.queue), jobId)
      pipeline.del(this.jobKey(jobId))
      await pipeline.exec()
    } else {
      await this.redis.del(this.jobKey(jobId))
    }
  }

  /**
   * Mark a job as failed.
   */
  async fail(job: QueuedJob, error: Error): Promise<void> {
    // Update job with failure info
    const failedData = {
      failedAt: new Date().toISOString(),
      error: error.message,
      stack: error.stack ?? '',
    }
    await this.redis.hset(this.jobKey(job.id), failedData)

    // Remove from reserved, add to failed list
    const pipeline = this.redis.pipeline()
    pipeline.zrem(this.reservedKey(job.queue), job.id)
    pipeline.lpush(this.failedKey(job.queue), job.id)
    await pipeline.exec()
  }

  /**
   * Get the number of jobs in a queue.
   */
  async size(queue: string): Promise<number> {
    return this.redis.zcard(this.pendingKey(queue))
  }

  /**
   * Get failed jobs.
   */
  async getFailedJobs(queue?: string): Promise<FailedJob[]> {
    const jobs: FailedJob[] = []

    if (queue) {
      jobs.push(...(await this.getFailedJobsForQueue(queue)))
    } else {
      // Get all queues with failed jobs
      const pattern = `${this.prefix}*:failed`
      let cursor = '0'
      const queueKeys: string[] = []

      do {
        const [newCursor, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
        cursor = newCursor
        queueKeys.push(...keys)
      } while (cursor !== '0')

      for (const key of queueKeys) {
        const queueName = key.replace(this.prefix, '').replace(':failed', '')
        jobs.push(...(await this.getFailedJobsForQueue(queueName)))
      }
    }

    return jobs.sort((a, b) => b.failedAt.getTime() - a.failedAt.getTime())
  }

  private async getFailedJobsForQueue(queue: string): Promise<FailedJob[]> {
    const jobIds = await this.redis.lrange(this.failedKey(queue), 0, -1)
    const jobs: FailedJob[] = []

    for (const jobId of jobIds) {
      const jobData = await this.redis.hgetall(this.jobKey(jobId))
      if (jobData && jobData.id) {
        const job = this.parseJobData(jobData)
        jobs.push({
          ...job,
          failedAt: new Date(jobData.failedAt || Date.now()),
          error: jobData.error || 'Unknown error',
          stack: jobData.stack,
        })
      }
    }

    return jobs
  }

  /**
   * Retry a failed job.
   */
  async retryFailedJob(jobId: string): Promise<void> {
    const jobData = await this.redis.hgetall(this.jobKey(jobId))
    if (!jobData || !jobData.queue) {
      throw new Error(`Failed job not found: ${jobId}`)
    }

    const queue = jobData.queue

    // Remove from failed list
    await this.redis.lrem(this.failedKey(queue), 1, jobId)

    // Reset job data
    const now = new Date()
    await this.redis.hset(this.jobKey(jobId), {
      attempts: '0',
      availableAt: now.toISOString(),
      createdAt: now.toISOString(),
    })
    await this.redis.hdel(this.jobKey(jobId), 'reservedAt', 'failedAt', 'error', 'stack', 'lastError')

    // Add to pending
    await this.redis.zadd(this.pendingKey(queue), now.getTime(), jobId)
  }

  /**
   * Delete a failed job.
   */
  async deleteFailedJob(jobId: string): Promise<void> {
    const jobData = await this.redis.hgetall(this.jobKey(jobId))
    if (jobData && jobData.queue) {
      await this.redis.lrem(this.failedKey(jobData.queue), 1, jobId)
    }
    await this.redis.del(this.jobKey(jobId))
  }

  /**
   * Clear all jobs (for testing).
   */
  async clear(): Promise<void> {
    const pattern = this.prefix + '*'
    let cursor = '0'
    const keys: string[] = []

    do {
      const [newCursor, foundKeys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
      cursor = newCursor
      keys.push(...foundKeys)
    } while (cursor !== '0')

    if (keys.length > 0) {
      await this.redis.del(...keys)
    }
  }

  /**
   * Parse job data from Redis hash.
   */
  private parseJobData(data: Record<string, string>): QueuedJob {
    return {
      id: data.id,
      name: data.name,
      payload: JSON.parse(data.payload || '{}'),
      queue: data.queue,
      attempts: parseInt(data.attempts || '0', 10),
      maxAttempts: parseInt(data.maxAttempts || '3', 10),
      availableAt: new Date(data.availableAt),
      createdAt: new Date(data.createdAt),
      reservedAt: data.reservedAt ? new Date(data.reservedAt) : null,
      lastError: data.lastError,
    }
  }
}
