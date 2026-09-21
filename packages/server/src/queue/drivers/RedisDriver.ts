import { randomUUID } from 'node:crypto'
import { PUSH, POP, RELEASE, DELETE, FAIL, EXTEND, RETRY, DELETE_FAILED } from './redis-queue-scripts'
import type { Redis } from 'ioredis'
import type { QueueDriver, QueuedJob, FailedJob } from '../types'

export interface RedisDriverOptions {
  /** @default 'queue:' */
  prefix?: string

  /** Jobs reserved longer than this are released. Milliseconds. @default 60000 */
  visibilityTimeout?: number
}

/**
 * Redis-backed queue driver for production. Key layout:
 * `{prefix}{queue}:pending` Sorted Set (score = availableAt),
 * `{prefix}{queue}:reserved` Sorted Set (score = timeout),
 * `{prefix}{queue}:failed` List of job IDs, `{prefix}job:{id}` Hash of job data.
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
    if (!Number.isFinite(this.visibilityTimeout) || this.visibilityTimeout < 3) {
      throw new Error('Redis queue visibilityTimeout must be at least 3 milliseconds')
    }
  }

  get heartbeatInterval(): number {
    return Math.max(1, Math.floor(this.visibilityTimeout / 3))
  }

  async extendReservation(job: QueuedJob): Promise<boolean> {
    if (!job.reservationToken) return false
    return await this.redis.eval(EXTEND, 2, this.jobKey(job.id), this.reservedKey(job.queue),
      job.id, job.reservationToken, Date.now() + this.visibilityTimeout) === 1
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

    await this.redis.eval(PUSH, 2, this.jobKey(job.id), this.pendingKey(job.queue),
      job.id, job.availableAt.getTime(), ...Object.entries(jobData).flat())
  }

  async pop(queue: string): Promise<QueuedJob | null> {
    const now = Date.now()
    const fields = await this.redis.eval(POP, 2, this.pendingKey(queue), this.reservedKey(queue),
      now, now + this.visibilityTimeout, new Date(now).toISOString(), randomUUID(), this.jobKey('')) as string[]
    if (fields.length === 0) return null
    const data: Record<string, string> = {}
    for (let i = 0; i < fields.length; i += 2) data[fields[i]!] = fields[i + 1]!
    return this.parseJobData(data)
  }

  async release(job: QueuedJob, delayMs: number = 0): Promise<void> {
    const availableAt = Date.now() + delayMs
    await this.redis.eval(RELEASE, 3, this.jobKey(job.id), this.pendingKey(job.queue), this.reservedKey(job.queue),
      job.id, job.reservationToken ?? '', job.attempts, new Date(availableAt).toISOString(), job.lastError ?? '', availableAt)
  }

  async delete(jobId: string, reservationToken?: string): Promise<void> {
    const queue = await this.redis.hget(this.jobKey(jobId), 'queue')
    if (queue === null) return
    await this.redis.eval(DELETE, 3, this.jobKey(jobId), this.pendingKey(queue), this.reservedKey(queue),
      jobId, reservationToken ?? '')
  }

  async fail(job: QueuedJob, error: Error): Promise<void> {
    await this.redis.eval(FAIL, 4, this.jobKey(job.id), this.pendingKey(job.queue), this.reservedKey(job.queue), this.failedKey(job.queue),
      job.id, job.reservationToken ?? '', new Date().toISOString(), error.message, error.stack ?? '', job.attempts)
  }

  async size(queue: string): Promise<number> {
    return this.redis.zcard(this.pendingKey(queue))
  }

  async getFailedJobs(queue?: string): Promise<FailedJob[]> {
    const jobs: FailedJob[] = []

    if (queue) {
      jobs.push(...(await this.getFailedJobsForQueue(queue)))
    } else {
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

  async retryFailedJob(jobId: string): Promise<void> {
    const queue = await this.redis.hget(this.jobKey(jobId), 'queue')
    const now = new Date()
    if (queue === null || await this.redis.eval(RETRY, 3, this.jobKey(jobId), this.pendingKey(queue), this.failedKey(queue),
      jobId, now.toISOString(), now.getTime()) === 0) {
      throw new Error(`Failed job not found: ${jobId}`)
    }
  }

  async deleteFailedJob(jobId: string): Promise<void> {
    const queue = await this.redis.hget(this.jobKey(jobId), 'queue')
    if (queue !== null) await this.redis.eval(DELETE_FAILED, 2, this.jobKey(jobId), this.failedKey(queue), jobId)
  }

  /** Testing only. */
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
      reservationToken: data.reservationToken,
    }
  }
}
