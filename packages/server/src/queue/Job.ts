import { randomBytes } from 'node:crypto'
import type { QueueDriver, QueuedJob, JobOptions } from './types'
import type { ServiceBindings } from '../container/bindings'
import { getContainer } from '../container/Container'

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
   * Stable wire name for this job.
   *
   * Queued messages record this name, and the worker resolves the class back
   * from it. When omitted the class name is used, which breaks if a bundler
   * mangles identifiers or if the class is later renamed while messages are
   * still in flight. Set it to pin the name across both.
   *
   * @default the class name
   */
  static jobName?: string

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

  protected make<K extends keyof ServiceBindings>(key: K): ServiceBindings[K]
  protected make<TService>(key: string): TService
  protected make(key: string): unknown {
    return getContainer().make(key)
  }

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
      name: resolveJobName(this),
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
  jobName?: string
  queue: string
  maxAttempts: number
  backoff: 'exponential' | 'linear' | number
  dispatch(payload: T, options?: JobOptions): Promise<string>
  dispatchAfter(delayMs: number, payload: T, options?: Omit<JobOptions, 'delay'>): Promise<string>
  calculateRetryDelay(attempts: number): number
}

/**
 * Resolve the wire name a job is queued and looked up under.
 *
 * Prefers an explicit `jobName` over the class name so that renaming the class
 * or bundling with identifier mangling does not orphan queued messages.
 *
 * Only an *own* `jobName` counts. Static members are inherited, so reading it
 * off the prototype chain would make every subclass of a pinned job claim its
 * parent's identity and overwrite it in the registry. A subclass that wants a
 * pinned name declares its own.
 */
export function resolveJobName(jobClass: Pick<JobClass, 'name' | 'jobName'>): string {
  const own = Object.prototype.hasOwnProperty.call(jobClass, 'jobName')
    ? jobClass.jobName
    : undefined
  return own ?? jobClass.name
}

/**
 * Job registry for looking up job classes by name.
 */
const jobRegistry = new Map<string, JobClass>()

/**
 * Register a job class for the worker to use.
 */
export function registerJob<T>(jobClass: JobClass<T>): void {
  jobRegistry.set(resolveJobName(jobClass), jobClass as JobClass)
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
