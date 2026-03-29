import type { QueueDriver } from './types'
import { setQueueDriver } from './Job'

/**
 * Queue driver factory function.
 */
export type QueueDriverFactory = () => QueueDriver

/**
 * Queue configuration.
 */
export interface QueueConfig {
  /**
   * Default driver name.
   * @default 'memory'
   */
  default?: string

  /**
   * Driver configurations.
   */
  drivers?: Record<string, QueueDriverFactory>
}

/**
 * Queue manager for handling multiple queue drivers.
 *
 * @example
 * ```ts
 * import { QueueManager, MemoryDriver, RedisDriver } from '@guren/server/queue'
 * import { createRedisClient } from '@guren/server/redis'
 *
 * const redis = createRedisClient({ url: process.env.REDIS_URL })
 *
 * const queueManager = new QueueManager({
 *   default: 'redis',
 *   drivers: {
 *     memory: () => new MemoryDriver(),
 *     redis: () => new RedisDriver(redis),
 *   }
 * })
 *
 * // Use the default driver
 * const driver = queueManager.driver()
 *
 * // Use a specific driver
 * const memoryDriver = queueManager.driver('memory')
 * ```
 */
export class QueueManager {
  private readonly defaultDriver: string
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

  /**
   * Get a queue driver by name.
   * Returns the default driver if no name is specified.
   */
  driver(name?: string): QueueDriver {
    const driverName = name ?? this.defaultDriver

    // Return cached driver if already resolved
    const cached = this.resolvedDrivers.get(driverName)
    if (cached) {
      return cached
    }

    // Get factory and create driver
    const factory = this.driverFactories.get(driverName)
    if (!factory) {
      throw new Error(`Queue driver not found: ${driverName}`)
    }

    const driver = factory()
    this.resolvedDrivers.set(driverName, driver)

    // Set as global driver if it's the default
    if (driverName === this.defaultDriver) {
      setQueueDriver(driver)
    }

    return driver
  }

  /**
   * Register a custom driver factory.
   */
  registerDriver(name: string, factory: QueueDriverFactory): void {
    this.driverFactories.set(name, factory)
    // Clear cached instance if exists
    this.resolvedDrivers.delete(name)
  }

  /**
   * Check if a driver is registered.
   */
  hasDriver(name: string): boolean {
    return this.driverFactories.has(name)
  }

  /**
   * Get the default driver name.
   */
  getDefaultDriverName(): string {
    return this.defaultDriver
  }

  /**
   * Get all registered driver names.
   */
  getDriverNames(): string[] {
    return Array.from(this.driverFactories.keys())
  }

  /**
   * Set the default driver and update global driver.
   */
  setDefaultDriver(name: string): void {
    if (!this.driverFactories.has(name)) {
      throw new Error(`Queue driver not found: ${name}`)
    }

    const driver = this.driver(name)
    setQueueDriver(driver)
  }
}

/**
 * Create a queue manager with default configuration.
 */
export function createQueueManager(config?: QueueConfig): QueueManager {
  return new QueueManager(config)
}
