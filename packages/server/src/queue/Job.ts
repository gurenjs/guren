import { randomBytes } from 'node:crypto'
import type { QueueDriver, QueuedJob, JobOptions } from './types'

/**
 * Global queue driver instance.
 * Set via setQueueDriver() or QueueManager.
 */
let globalDriver: QueueDriver | null = null

/**
 * Set the global queue driver.
 */
export function setQueueDriver(driver: QueueDriver): void {
  globalDriver = driver
}

/**
 * Get the global queue driver.
 */
export function getQueueDriver(): QueueDriver | null {
  return globalDriver
}

/**
 * Generate a unique job ID.
 */
function generateJobId(): string {
  return randomBytes(16).toString('hex')
}

/**
 * Base class for defining jobs.
 *
 * @example
 * ```ts
 * class SendWelcomeEmailJob extends Job<{ userId: string }> {
 *   static queue = 'emails'
 *   static maxAttempts = 5
 *
 *   async handle({ userId }: { userId: string }): Promise<void> {
 *     const user = await User.find(userId)
 *     await mail.to(user.email).template(WelcomeEmail, user).send()
 *   }
 *
 *   async failed({ userId }: { userId: string }, error: Error): Promise<void> {
 *     console.error(`Failed to send welcome email to user ${userId}:`, error)
 *   }
 * }
 *
 * // Dispatch the job
 * await SendWelcomeEmailJob.dispatch({ userId: '123' })
 *
 * // Dispatch with delay
 * await SendWelcomeEmailJob.dispatchAfter(60000, { userId: '123' })
 * ```
 */
export abstract class Job<T = unknown> {
  /**
   * The queue this job should be dispatched to.
   * @default 'default'
   */
  static queue = 'default'

  /**
   * Maximum number of times the job should be attempted.
   * @default 3
   */
  static maxAttempts = 3

  /**
   * Backoff strategy for retries.
   * - 'exponential': 2^attempt * 1000ms (1s, 2s, 4s, 8s, ...)
   * - 'linear': attempt * 1000ms (1s, 2s, 3s, 4s, ...)
   * - number: fixed delay in milliseconds
   * @default 'exponential'
   */
  static backoff: 'exponential' | 'linear' | number = 'exponential'

  /**
   * Handle the job.
   * Override this method to define job logic.
   */
  abstract handle(payload: T): void | Promise<void>

  /**
   * Called when the job fails permanently (after all retries exhausted).
   * Override this method to handle failures.
   */
  failed?(payload: T, error: Error): void | Promise<void>

  /**
   * Dispatch the job to the queue.
   *
   * @param payload - Job payload data
   * @param options - Optional dispatch options
   */
  static async dispatch<T>(
    this: JobClass<T>,
    payload: T,
    options: JobOptions = {}
  ): Promise<string> {
    const driver = globalDriver
    if (!driver) {
      throw new Error('Queue driver not configured. Call setQueueDriver() first.')
    }

    const jobId = generateJobId()
    const now = new Date()
    const delay = options.delay ?? 0

    const job: QueuedJob<T> = {
      id: jobId,
      name: this.name,
      payload,
      queue: options.queue ?? this.queue,
      attempts: 0,
      maxAttempts: options.maxAttempts ?? this.maxAttempts,
      availableAt: new Date(now.getTime() + delay),
      createdAt: now,
      reservedAt: null,
    }

    await driver.push(job)
    return jobId
  }

  /**
   * Dispatch the job after a delay.
   *
   * @param delayMs - Delay in milliseconds
   * @param payload - Job payload data
   * @param options - Optional dispatch options (delay is overridden)
   */
  static async dispatchAfter<T>(
    this: JobClass<T>,
    delayMs: number,
    payload: T,
    options: Omit<JobOptions, 'delay'> = {}
  ): Promise<string> {
    return this.dispatch(payload, { ...options, delay: delayMs })
  }

  /**
   * Calculate the retry delay based on backoff strategy.
   */
  static calculateRetryDelay(attempts: number): number {
    if (typeof this.backoff === 'number') {
      return this.backoff
    }

    if (this.backoff === 'linear') {
      return attempts * 1000
    }

    // exponential
    return Math.pow(2, attempts) * 1000
  }
}

/**
 * Job class constructor type.
 */
export interface JobClass<T = unknown> {
  new (): Job<T>
  name: string
  queue: string
  maxAttempts: number
  backoff: 'exponential' | 'linear' | number
  dispatch(payload: T, options?: JobOptions): Promise<string>
  dispatchAfter(delayMs: number, payload: T, options?: Omit<JobOptions, 'delay'>): Promise<string>
  calculateRetryDelay(attempts: number): number
}

/**
 * Job registry for looking up job classes by name.
 */
const jobRegistry = new Map<string, JobClass>()

/**
 * Register a job class for the worker to use.
 */
export function registerJob<T>(jobClass: JobClass<T>): void {
  jobRegistry.set(jobClass.name, jobClass as JobClass)
}

/**
 * Get a registered job class by name.
 */
export function getJob(name: string): JobClass | undefined {
  return jobRegistry.get(name)
}

/**
 * Get all registered job classes.
 */
export function getRegisteredJobs(): Map<string, JobClass> {
  return new Map(jobRegistry)
}

/**
 * Clear all registered jobs (for testing).
 */
export function clearJobRegistry(): void {
  jobRegistry.clear()
}
