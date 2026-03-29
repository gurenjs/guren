import type { CheckResult } from '../types'
import { HealthCheck } from '../HealthCheck'

/**
 * Storage driver interface (minimal).
 */
export interface StorageDriverInterface {
  put(path: string, contents: string | Buffer): Promise<void>
  get(path: string): Promise<Buffer | null>
  delete(path: string): Promise<boolean>
}

/**
 * Options for storage health check.
 */
export interface StorageCheckOptions {
  /**
   * Custom name for this check.
   * @default 'storage'
   */
  name?: string

  /**
   * Test file path.
   * @default '__health_check__.txt'
   */
  testPath?: string
}

/**
 * Health check for storage functionality.
 */
export class StorageCheck extends HealthCheck {
  readonly name: string

  private storage: StorageDriverInterface
  private testPath: string

  constructor(
    storage: StorageDriverInterface,
    options: StorageCheckOptions = {}
  ) {
    super()
    this.storage = storage
    this.name = options.name ?? 'storage'
    this.testPath = options.testPath ?? '__health_check__.txt'
  }

  async check(): Promise<CheckResult> {
    const testContent = `health_check_${Date.now()}`

    try {
      // Test write
      await this.storage.put(this.testPath, testContent)

      // Test read
      const retrieved = await this.storage.get(this.testPath)

      // Clean up
      await this.storage.delete(this.testPath)

      if (retrieved && retrieved.toString() === testContent) {
        return this.healthy('Storage is functioning correctly')
      }

      return this.degraded('Storage read/write mismatch')
    } catch (error) {
      return this.handleError(error, 'Storage operation failed')
    }
  }
}
