import { getJob } from '@guren/server'
import type { FailedJob, QueuedJob, QueueDriver, JobClass } from '@guren/server'

/**
 * Recorded job for testing.
 */
export interface RecordedJob<T = unknown> {
  jobClass?: JobClass<T>
  jobName: string
  payload: T
  options: {
    queue: string
    delay: number
  }
  timestamp: Date
  queuedJob: QueuedJob<T>
}

/**
 * Fake queue driver for testing.
 */
export class FakeQueueDriver implements QueueDriver {
  private jobs: RecordedJob[] = []
  private failedJobs: FailedJob[] = []
  private jobClasses = new Map<string, JobClass>()

  registerJobClass<T>(jobClass: JobClass<T>): void {
    this.jobClasses.set(jobClass.name, jobClass as JobClass)
  }

  async push(job: QueuedJob): Promise<void> {
    const delay = Math.max(0, job.availableAt.getTime() - job.createdAt.getTime())
    const jobClass = this.jobClasses.get(job.name) ?? getJob(job.name)

    this.jobs.push({
      jobClass: jobClass as JobClass | undefined,
      jobName: job.name,
      payload: job.payload,
      options: {
        queue: job.queue,
        delay,
      },
      timestamp: new Date(),
      queuedJob: job,
    })
  }

  async pop(queue: string): Promise<QueuedJob | null> {
    const index = this.jobs.findIndex((job) => job.options.queue === queue)
    if (index === -1) {
      return null
    }

    const [record] = this.jobs.splice(index, 1)
    return record.queuedJob
  }

  async release(job: QueuedJob, delayMs: number = 0): Promise<void> {
    const now = new Date()
    const released: QueuedJob = {
      ...job,
      availableAt: new Date(now.getTime() + delayMs),
      reservedAt: null,
    }
    await this.push(released)
  }

  async delete(jobId: string): Promise<void> {
    this.jobs = this.jobs.filter((job) => job.queuedJob.id !== jobId)
    this.failedJobs = this.failedJobs.filter((job) => job.id !== jobId)
  }

  async fail(job: QueuedJob, error: Error): Promise<void> {
    this.failedJobs.push({
      ...job,
      failedAt: new Date(),
      error: error.message,
      stack: error.stack,
    })
  }

  async size(queue: string): Promise<number> {
    return this.jobs.filter((job) => job.options.queue === queue).length
  }

  async getFailedJobs(queue?: string): Promise<FailedJob[]> {
    if (!queue) {
      return [...this.failedJobs]
    }

    return this.failedJobs.filter((job) => job.queue === queue)
  }

  async retryFailedJob(jobId: string): Promise<void> {
    const index = this.failedJobs.findIndex((job) => job.id === jobId)
    if (index === -1) {
      return
    }

    const [failed] = this.failedJobs.splice(index, 1)
    const { failedAt, error, stack, ...queuedJob } = failed
    void failedAt
    void error
    void stack
    await this.push(queuedJob as QueuedJob)
  }

  async deleteFailedJob(jobId: string): Promise<void> {
    this.failedJobs = this.failedJobs.filter((job) => job.id !== jobId)
  }

  async clear(): Promise<void> {
    this.jobs = []
    this.failedJobs = []
  }

  /**
   * Get all recorded jobs.
   */
  getJobs(): RecordedJob[] {
    return [...this.jobs]
  }

  /**
   * Get jobs of a specific type.
   */
  getJobsOf<T>(jobClass: JobClass<T>): RecordedJob<T>[] {
    return this.jobs.filter(
      (j) => j.jobClass === jobClass || j.jobName === jobClass.name
    ) as RecordedJob<T>[]
  }
}

/**
 * Fake queue for testing job dispatches.
 */
export class FakeQueue {
  private driver: FakeQueueDriver

  constructor() {
    this.driver = new FakeQueueDriver()
  }

  /**
   * Get the underlying driver.
   */
  getDriver(): FakeQueueDriver {
    return this.driver
  }

  /**
   * Record a job dispatch.
   */
  record<T>(jobClass: JobClass<T>, payload: T, options: { queue?: string; delay?: number } = {}): void {
    this.driver.registerJobClass(jobClass)
    const now = new Date()
    const delay = options.delay ?? 0
    const queuedJob: QueuedJob<T> = {
      id: `fake-job-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: jobClass.name,
      payload,
      queue: options.queue ?? jobClass.queue,
      attempts: 0,
      maxAttempts: jobClass.maxAttempts,
      availableAt: new Date(now.getTime() + delay),
      createdAt: now,
      reservedAt: null,
    }

    void this.driver.push(queuedJob)
  }

  /**
   * Assert a job was pushed.
   */
  assertPushed<T>(
    jobClass: JobClass<T>,
    callback?: (payload: T) => boolean
  ): void {
    const jobs = this.driver.getJobsOf(jobClass)

    if (jobs.length === 0) {
      throw new Error(`Expected job [${jobClass.name}] to be pushed`)
    }

    if (callback) {
      const match = jobs.some((j) => callback(j.payload))
      if (!match) {
        throw new Error(
          `Expected job [${jobClass.name}] to match callback, but none did`
        )
      }
    }
  }

  /**
   * Assert a job was pushed a specific number of times.
   */
  assertPushedTimes<T>(jobClass: JobClass<T>, times: number): void {
    const jobs = this.driver.getJobsOf(jobClass)

    if (jobs.length !== times) {
      throw new Error(
        `Expected job [${jobClass.name}] to be pushed ${times} times, got ${jobs.length}`
      )
    }
  }

  /**
   * Assert a job was not pushed.
   */
  assertNotPushed<T>(jobClass: JobClass<T>): void {
    const jobs = this.driver.getJobsOf(jobClass)

    if (jobs.length > 0) {
      throw new Error(
        `Expected job [${jobClass.name}] not to be pushed, but it was pushed ${jobs.length} times`
      )
    }
  }

  /**
   * Assert no jobs were pushed.
   */
  assertNothingPushed(): void {
    const jobs = this.driver.getJobs()

    if (jobs.length > 0) {
      const names = [...new Set(jobs.map((j) => j.jobName))]
      throw new Error(
        `Expected no jobs to be pushed, but found: ${names.join(', ')}`
      )
    }
  }

  /**
   * Assert a job was pushed to a specific queue.
   */
  assertPushedOn<T>(queue: string, jobClass: JobClass<T>): void {
    const jobs = this.driver.getJobsOf(jobClass)
    const match = jobs.some((j) => j.options.queue === queue)

    if (!match) {
      throw new Error(
        `Expected job [${jobClass.name}] to be pushed to queue [${queue}]`
      )
    }
  }

  /**
   * Assert a job was pushed with a delay.
   */
  assertPushedWithDelay<T>(jobClass: JobClass<T>, delay: number): void {
    const jobs = this.driver.getJobsOf(jobClass)
    const match = jobs.some((j) => j.options.delay === delay)

    if (!match) {
      throw new Error(
        `Expected job [${jobClass.name}] to be pushed with delay [${delay}]`
      )
    }
  }

  /**
   * Get pushed jobs of a specific type.
   */
  pushed<T>(jobClass: JobClass<T>): RecordedJob<T>[] {
    return this.driver.getJobsOf(jobClass)
  }

  /**
   * Get all pushed jobs.
   */
  all(): RecordedJob[] {
    return this.driver.getJobs()
  }

  /**
   * Clear all recorded jobs.
   */
  clear(): void {
    void this.driver.clear()
  }
}

/**
 * Create a fake queue for testing.
 */
export function fakeQueue(): FakeQueue {
  return new FakeQueue()
}
