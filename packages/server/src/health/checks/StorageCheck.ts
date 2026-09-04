import type { CheckResult } from '../types'
import { HealthCheck } from '../HealthCheck'

export interface StorageDriverInterface {
  put(path: string, contents: string | Buffer): Promise<void>
  get(path: string): Promise<Buffer | null>
  delete(path: string): Promise<boolean>
}

export interface StorageCheckOptions {
  /** @default 'storage' */
  name?: string

  /** @default '__health_check__.txt' */
  testPath?: string
}

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
      await this.storage.put(this.testPath, testContent)

      const retrieved = await this.storage.get(this.testPath)

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
