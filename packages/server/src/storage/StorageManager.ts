import type {
  StorageDriver,
  StorageDriverFactory,
  StorageConfig,
  DriverConfig,
  LocalDriverOptions,
  S3DriverOptions,
  MemoryDriverOptions,
} from './types'
import { LocalDriver } from './drivers/LocalDriver'
import { S3Driver } from './drivers/S3Driver'
import { MemoryDriver } from './drivers/MemoryDriver'

/**
 * Storage manager for handling multiple storage disks.
 *
 * @example
 * ```ts
 * const storage = new StorageManager({
 *   default: 'local',
 *   disks: {
 *     local: { driver: 'local', root: './storage/app' },
 *     s3: { driver: 's3', bucket: 'my-bucket', region: 'ap-northeast-1' },
 *   }
 * })
 *
 * // Use the default disk
 * await storage.disk().put('avatars/user-1.jpg', imageBuffer)
 *
 * // Use a specific disk
 * await storage.disk('s3').put('avatars/user-1.jpg', imageBuffer)
 * ```
 */
export class StorageManager {
  private readonly defaultDiskName: string
  private readonly diskFactories: Map<string, StorageDriverFactory> = new Map()
  private readonly resolvedDisks: Map<string, StorageDriver> = new Map()
  private driverFactories: Map<string, (options: unknown) => StorageDriver> = new Map()

  constructor(config: StorageConfig = {}) {
    this.defaultDiskName = config.default ?? 'local'

    // Register built-in drivers
    this.registerBuiltinDrivers()

    // Register disks from config
    if (config.disks) {
      for (const [name, diskConfig] of Object.entries(config.disks)) {
        this.registerDiskFromConfig(name, diskConfig)
      }
    }

    // Register default local disk if no disks configured
    if (!this.diskFactories.has(this.defaultDiskName) && this.defaultDiskName === 'local') {
      this.diskFactories.set('local', () => new LocalDriver({ root: './storage' }))
    }
  }

  /**
   * Register built-in disk drivers.
   */
  private registerBuiltinDrivers(): void {
    // Local driver
    this.driverFactories.set('local', (options: unknown) => {
      return new LocalDriver(options as LocalDriverOptions)
    })

    // S3 driver
    this.driverFactories.set('s3', (options: unknown) => {
      return new S3Driver(options as S3DriverOptions)
    })

    // Memory driver
    this.driverFactories.set('memory', (options: unknown) => {
      return new MemoryDriver(options as MemoryDriverOptions)
    })
  }

  /**
   * Register a disk from configuration.
   */
  private registerDiskFromConfig(
    name: string,
    config: DriverConfig
  ): void {
    const { driver, ...options } = config
    const factory = this.driverFactories.get(driver)

    if (!factory) {
      throw new Error(`Unknown storage driver: ${driver}`)
    }

    this.diskFactories.set(name, () => factory(options))
  }

  /**
   * Get a storage disk by name.
   * Returns the default disk if no name is specified.
   */
  disk(name?: string): StorageDriver {
    const diskName = name ?? this.defaultDiskName

    // Return cached disk if already resolved
    const cached = this.resolvedDisks.get(diskName)
    if (cached) {
      return cached
    }

    // Get factory and create disk
    const factory = this.diskFactories.get(diskName)
    if (!factory) {
      throw new Error(`Storage disk not found: ${diskName}`)
    }

    const disk = factory()
    this.resolvedDisks.set(diskName, disk)
    return disk
  }

  /**
   * Register a custom disk factory.
   */
  registerDisk(name: string, factory: StorageDriverFactory): void {
    this.diskFactories.set(name, factory)
    // Clear cached instance if exists
    this.resolvedDisks.delete(name)
  }

  /**
   * Register a custom driver.
   */
  registerDriver(name: string, factory: (options: unknown) => StorageDriver): void {
    this.driverFactories.set(name, factory)
  }

  /**
   * Check if a disk is registered.
   */
  hasDisk(name: string): boolean {
    return this.diskFactories.has(name)
  }

  /**
   * Get the default disk name.
   */
  getDefaultDiskName(): string {
    return this.defaultDiskName
  }

  /**
   * Get all registered disk names.
   */
  getDiskNames(): string[] {
    return Array.from(this.diskFactories.keys())
  }
}

/**
 * Create a storage manager with configuration.
 */
export function createStorageManager(config?: StorageConfig): StorageManager {
  return new StorageManager(config)
}
