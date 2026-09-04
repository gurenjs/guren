import { randomBytes } from 'node:crypto'
import type { QueueDriver, QueuedJob, JobOptions } from './types'
import type { ServiceBindings } from '../container/bindings'
import { getContainer } from '../container/Container'

let globalDriver: QueueDriver | null = null

export function setQueueDriver(driver: QueueDriver): void {
  globalDriver = driver
}

export function getQueueDriver(): QueueDriver | null {
  return globalDriver
}

function generateJobId(): string {
  return randomBytes(16).toString('hex')
}

export abstract class Job<T = unknown> {
  /**
   * Stable wire name: queued messages record it and the worker resolves the
   * class back from it. Defaults to the class name, which breaks under
   * identifier mangling or a rename with messages still in flight.
   * @default the class name
   */
  static jobName?: string

  /** @default 'default' */
  static queue = 'default'

  /** @default 3 */
  static maxAttempts = 3

  /**
   * 'exponential' = 2^attempt * 1000ms, 'linear' = attempt * 1000ms, a number
   * is a fixed delay in milliseconds.
   * @default 'exponential'
   */
  static backoff: 'exponential' | 'linear' | number = 'exponential'

  protected make<K extends keyof ServiceBindings>(key: K): ServiceBindings[K]
  protected make<TService>(key: string): TService
  protected make(key: string): unknown {
    return getContainer().make(key)
  }

  abstract handle(payload: T): void | Promise<void>

  /** Called once retries are exhausted. */
  failed?(payload: T, error: Error): void | Promise<void>

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

  static async dispatchAfter<T>(
    this: JobClass<T>,
    delayMs: number,
    payload: T,
    options: Omit<JobOptions, 'delay'> = {}
  ): Promise<string> {
    return this.dispatch(payload, { ...options, delay: delayMs })
  }

  static calculateRetryDelay(attempts: number): number {
    if (typeof this.backoff === 'number') {
      return this.backoff
    }

    if (this.backoff === 'linear') {
      return attempts * 1000
    }

    return Math.pow(2, attempts) * 1000
  }
}

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
 * Only an *own* `jobName` counts: statics are inherited, so reading the
 * prototype chain would make every subclass of a pinned job claim its
 * parent's identity and overwrite it in the registry.
 */
export function resolveJobName(jobClass: Pick<JobClass, 'name' | 'jobName'>): string {
  const own = Object.prototype.hasOwnProperty.call(jobClass, 'jobName')
    ? jobClass.jobName
    : undefined
  return own ?? jobClass.name
}

const jobRegistry = new Map<string, JobClass>()

export function registerJob<T>(jobClass: JobClass<T>): void {
  jobRegistry.set(resolveJobName(jobClass), jobClass as JobClass)
}

export function getJob(name: string): JobClass | undefined {
  return jobRegistry.get(name)
}

export function getRegisteredJobs(): Map<string, JobClass> {
  return new Map(jobRegistry)
}

/** Testing only. */
export function clearJobRegistry(): void {
  jobRegistry.clear()
}
