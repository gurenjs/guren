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
import { describeDriverMap } from '../introspection/driver-map'
import type { DriverMapEntry } from '../introspection/types'

export class StorageManager {
  private readonly defaultDiskName: string
  private readonly diskFactories: Map<string, StorageDriverFactory> = new Map()
  private readonly resolvedDisks: Map<string, StorageDriver> = new Map()
  /** The configured driver per disk, keyed like `diskFactories`; null for a bare `registerDisk()` factory. */
  private readonly diskDrivers: Map<string, string | null> = new Map()
  /** The Workers binding a disk reads, when its `registerDisk()` description names one. */
  private readonly diskBindings: Map<string, string> = new Map()
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
      this.diskDrivers.set('local', 'local')
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
    this.diskDrivers.set(name, driver)
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

  /**
   * `description` says what the factory builds, which `describe()` cannot learn without calling it:
   * `{ driver: 'r2', binding: 'MEDIA' }` lets the Cloudflare deploy see the bucket binding (RFC 0035 §2.1).
   */
  registerDisk(name: string, factory: StorageDriverFactory, description?: { driver: string; binding?: string }): void {
    this.diskFactories.set(name, factory)
    this.diskDrivers.set(name, description?.driver ?? null)
    if (description?.binding) this.diskBindings.set(name, description.binding)
    else this.diskBindings.delete(name)
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

  /** The declared disks and the default, building none of them (RFC 0026 §1). */
  describe(): DriverMapEntry {
    return describeDriverMap(this.defaultDiskName, this.diskDrivers, this.diskBindings)
  }
}

export function createStorageManager(config?: StorageConfig): StorageManager {
  return new StorageManager(config)
}
