import type { CheckResult } from '../types'
import { HealthCheck } from '../HealthCheck'

/**
 * Cache store interface (minimal).
 */
export interface CacheStoreInterface {
  get<T>(key: string): Promise<T | null>
  put<T>(key: string, value: T, ttl?: number): Promise<void>
  forget(key: string): Promise<boolean>
}

/**
 * Options for cache health check.
 */
export interface CacheCheckOptions {
  /**
   * Custom name for this check.
   * @default 'cache'
   */
  name?: string

  /**
   * Key to use for health check test.
   * @default '__health_check__'
   */
  testKey?: string
}

/**
 * Health check for cache functionality.
 */
export class CacheCheck extends HealthCheck {
  readonly name: string

  private cache: CacheStoreInterface
  private testKey: string

  constructor(cache: CacheStoreInterface, options: CacheCheckOptions = {}) {
    super()
    this.cache = cache
    this.name = options.name ?? 'cache'
    this.testKey = options.testKey ?? '__health_check__'
  }

  async check(): Promise<CheckResult> {
    const testValue = `health_check_${Date.now()}`

    try {
      // Test write
      await this.cache.put(this.testKey, testValue, 60)

      // Test read
      const retrieved = await this.cache.get<string>(this.testKey)

      // Clean up
      await this.cache.forget(this.testKey)

      if (retrieved === testValue) {
        return this.healthy('Cache is functioning correctly')
      }

      return this.degraded(
        `Cache read/write mismatch: expected "${testValue}", got "${retrieved}"`
      )
    } catch (error) {
      return this.unhealthy(
        error instanceof Error
          ? error.message
          : 'Cache operation failed'
      )
    }
  }
}
