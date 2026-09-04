import type { QueueDriver } from './types'
import { setQueueDriver } from './Job'

export type QueueDriverFactory = () => QueueDriver

export interface QueueConfig {
  /** @default 'memory' */
  default?: string

  drivers?: Record<string, QueueDriverFactory>
}

/**
 * Resolves queue drivers by name from the configured factories; `driver()` with
 * no name returns the default and publishes it as the global driver.
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

    if (driverName === this.defaultDriver) {
      setQueueDriver(driver)
    }

    return driver
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
   * After this, `driver()` with no name, `getDefaultDriverName()`, and
   * `Job.dispatch()` all use the new driver.
   */
  setDefaultDriver(name: string): void {
    if (!this.driverFactories.has(name)) {
      throw new Error(`Queue driver not found: ${name}`)
    }

    this.defaultDriver = name
    // driver() only publishes the global on first resolution; a driver that was
    // already resolved by name would otherwise stay off the global slot.
    setQueueDriver(this.driver(name))
  }
}

export function createQueueManager(config?: QueueConfig): QueueManager {
  return new QueueManager(config)
}
