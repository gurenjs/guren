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

export class StorageManager {
  private readonly defaultDiskName: string
  private readonly diskFactories: Map<string, StorageDriverFactory> = new Map()
  private readonly resolvedDisks: Map<string, StorageDriver> = new Map()
  private driverFactories: Map<string, (options: unknown) => StorageDriver> = new Map()

  constructor(config: StorageConfig = {}) {
    this.defaultDiskName = config.default ?? 'local'

    this.registerBuiltinDrivers()

    if (config.disks) {
      for (const [name, diskConfig] of Object.entries(config.disks)) {
        this.registerDiskFromConfig(name, diskConfig)
      }
    }

    if (!this.diskFactories.has(this.defaultDiskName) && this.defaultDiskName === 'local') {
      this.diskFactories.set('local', () => new LocalDriver({ root: './storage' }))
    }
  }

  private registerBuiltinDrivers(): void {
    this.driverFactories.set('local', (options: unknown) => {
      return new LocalDriver(options as LocalDriverOptions)
    })

    this.driverFactories.set('s3', (options: unknown) => {
      return new S3Driver(options as S3DriverOptions)
    })

    this.driverFactories.set('memory', (options: unknown) => {
      return new MemoryDriver(options as MemoryDriverOptions)
    })
  }

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

  disk(name?: string): StorageDriver {
    const diskName = name ?? this.defaultDiskName

    const cached = this.resolvedDisks.get(diskName)
    if (cached) {
      return cached
    }

    const factory = this.diskFactories.get(diskName)
    if (!factory) {
      throw new Error(`Storage disk not found: ${diskName}`)
    }

    const disk = factory()
    this.resolvedDisks.set(diskName, disk)
    return disk
  }

  registerDisk(name: string, factory: StorageDriverFactory): void {
    this.diskFactories.set(name, factory)
    this.resolvedDisks.delete(name)
  }

  registerDriver(name: string, factory: (options: unknown) => StorageDriver): void {
    this.driverFactories.set(name, factory)
  }

  hasDisk(name: string): boolean {
    return this.diskFactories.has(name)
  }

  getDefaultDiskName(): string {
    return this.defaultDiskName
  }

  getDiskNames(): string[] {
    return Array.from(this.diskFactories.keys())
  }
}

export function createStorageManager(config?: StorageConfig): StorageManager {
  return new StorageManager(config)
}
