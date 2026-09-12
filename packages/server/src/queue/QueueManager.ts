import type { JobOptions, QueueDriver } from './types'
import { enqueueJob, type JobClass } from './Job'

export type QueueDriverFactory = () => QueueDriver

export interface QueueConfig {
  /** @default 'memory' */
  default?: string

  drivers?: Record<string, QueueDriverFactory>
}

/**
 * Resolves queue drivers by name from the configured factories, memoized per
 * name. Nothing here writes the `Job.dispatch()` pin: `getQueueDriver()` reads
 * the manager the container holds, so a second app's manager is not shadowed by
 * the first one's driver.
 */
export class QueueManager {
  private defaultDriver: string
  private readonly driverFactories: Map<string, QueueDriverFactory> = new Map()
  private readonly resolvedDrivers: Map<string, QueueDriver> = new Map()

  constructor(config: QueueConfig = {}) {
    this.defaultDriver = config.default ?? 'memory'

    if (config.drivers) {
      for (const [name, factory] of Object.entries(config.drivers)) {
        this.driverFactories.set(name, factory)
      }
    }
  }

  driver(name?: string): QueueDriver {
    const driverName = name ?? this.defaultDriver

    const cached = this.resolvedDrivers.get(driverName)
    if (cached) {
      return cached
    }

    const factory = this.driverFactories.get(driverName)
    if (!factory) {
      throw new Error(`Queue driver not found: ${driverName}`)
    }

    const driver = factory()
    this.resolvedDrivers.set(driverName, driver)

    return driver
  }

  /**
   * Explicit form of `JobClass.dispatch(payload, options)`: the same message,
   * pushed through this manager's default driver rather than the ambient one
   * (RFC 0023 §3).
   */
  async dispatch<T>(JobClass: JobClass<T>, payload: T, options: JobOptions = {}): Promise<string> {
    return enqueueJob(this.driver(), JobClass, payload, options)
  }

  registerDriver(name: string, factory: QueueDriverFactory): void {
    this.driverFactories.set(name, factory)
    this.resolvedDrivers.delete(name)
  }

  hasDriver(name: string): boolean {
    return this.driverFactories.has(name)
  }

  getDefaultDriverName(): string {
    return this.defaultDriver
  }

  getDriverNames(): string[] {
    return Array.from(this.driverFactories.keys())
  }

  /**
   * After this, `driver()` with no name, `getDefaultDriverName()`, and — for a
   * manager bound as `queue` — `Job.dispatch()` all use the new driver.
   */
  setDefaultDriver(name: string): void {
    if (!this.driverFactories.has(name)) {
      throw new Error(`Queue driver not found: ${name}`)
    }

    this.defaultDriver = name
  }
}

export function createQueueManager(config?: QueueConfig): QueueManager {
  return new QueueManager(config)
}
