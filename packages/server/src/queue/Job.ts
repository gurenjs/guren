import { randomBytes } from 'node:crypto'
import type { QueueDriver, QueuedJob, JobOptions } from './types'
import type { QueueManager } from './QueueManager'
import type { ServiceBindings } from '../container/bindings'
import type { ContainerLike } from '../container/types'
import { resolveOptional } from '../container/resolve-optional'
import { ambientBinding, ambientContainer, defaultContainer } from '../http/default-application'

/**
 * The pin `setQueueDriver()` writes, and nothing else does. A manager that
 * published its own driver here pinned the first booted app's queue for every
 * later `Application` in the process.
 */
let globalDriver: QueueDriver | null = null

/**
 * Pins the driver `Job.dispatch()` sends through, ahead of the container's
 * `queue` manager. An explicit override rather than a fallback: `@guren/testing`'s
 * `fakeQueue()` and the tutorial's queue test inject through it (RFC 0023 §3).
 */
export function setQueueDriver(driver: QueueDriver): void {
  globalDriver = driver
}

/** Drops the pin, so `getQueueDriver()` falls back to the container again. */
export function clearQueueDriver(): void {
  globalDriver = null
}

/** @internal The driver `setQueueDriver()` pinned, for a dispatcher with a container of its own to honour first. */
export function pinnedQueueDriver(): QueueDriver | null {
  return globalDriver
}

/** The `queue` manager bound in the default application, or null when there is neither. */
function boundQueueManager(): QueueManager | null {
  return ambientBinding('queue') ?? null
}

/**
 * The driver `Job.dispatch()` sends through: the pin when set, else the default
 * driver of the `queue` manager the default application binds, else null.
 * Total by contract — every caller treats it as `QueueDriver | null`, so a
 * manager bound with no factory for its default must read as absent rather
 * than throw.
 */
export function getQueueDriver(): QueueDriver | null {
  if (globalDriver) return globalDriver

  const manager = boundQueueManager()
  if (!manager || !manager.hasDriver(manager.getDefaultDriverName())) return null
  return manager.driver()
}

/** Why `getQueueDriver()` came back null: a manager bound with no driver reads differently from no manager at all. */
function missingQueueDriverMessage(): string {
  const manager = boundQueueManager()
  if (manager) {
    return (
      `Queue driver not configured: the "queue" manager has no driver named "${manager.getDefaultDriverName()}". ` +
      'Register one with manager.registerDriver(name, factory), or pass createQueueManager({ drivers }) a factory for it.'
    )
  }
  return (
    'Queue driver not configured. Register a provider that binds a QueueManager as "queue" ' +
    '(QueueServiceProvider, or your own), or call setQueueDriver() first.'
  )
}

function generateJobId(): string {
  return randomBytes(16).toString('hex')
}

/**
 * The one enqueue behind `Job.dispatch()` and `QueueManager.dispatch()`, so the
 * two forms cannot write different messages.
 */
export async function enqueueJob<T>(
  driver: QueueDriver,
  JobClass: JobClass<T>,
  payload: T,
  options: JobOptions = {},
): Promise<string> {
  const jobId = generateJobId()
  const now = new Date()
  const delay = options.delay ?? 0

  const job: QueuedJob<T> = {
    id: jobId,
    name: resolveJobName(JobClass),
    payload,
    queue: options.queue ?? JobClass.queue,
    attempts: 0,
    maxAttempts: options.maxAttempts ?? JobClass.maxAttempts,
    availableAt: new Date(now.getTime() + delay),
    createdAt: now,
    reservedAt: null,
  }

  await driver.push(job)
  return jobId
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

  private container?: ContainerLike

  /** @internal Called by the Worker with the container of the app it drains, before `handle()`. */
  setContainer(container: ContainerLike): void {
    this.container = container
  }

  /** Resolves from the worker's container, else from the default application. */
  protected make<K extends keyof ServiceBindings>(key: K): ServiceBindings[K]
  protected make<TService>(key: string): TService
  protected make(key: string): unknown {
    return (this.container ?? defaultContainer()).make(key)
  }

  /** `make()` for a binding that may be absent: undefined when neither container holds it. */
  protected makeOptional<K extends keyof ServiceBindings>(key: K): ServiceBindings[K] | undefined
  protected makeOptional<TService>(key: string): TService | undefined
  protected makeOptional(key: string): unknown {
    return resolveOptional(this.container ?? ambientContainer(), key)
  }

  abstract handle(payload: T): void | Promise<void>

  /** Called once retries are exhausted. */
  failed?(payload: T, error: Error): void | Promise<void>

  static async dispatch<T>(
    this: JobClass<T>,
    payload: T,
    options: JobOptions = {}
  ): Promise<string> {
    const driver = getQueueDriver()
    if (!driver) {
      throw new Error(missingQueueDriverMessage())
    }

    return enqueueJob(driver, this, payload, options)
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
