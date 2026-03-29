import type { CheckResult } from '../types'
import { HealthCheck } from '../HealthCheck'

/**
 * Options for memory health check.
 */
export interface MemoryCheckOptions {
  /**
   * Custom name for this check.
   * @default 'memory'
   */
  name?: string

  /**
   * Memory threshold in MB. Above this is degraded.
   * @default 512
   */
  thresholdMb?: number

  /**
   * Critical memory threshold in MB. Above this is unhealthy.
   * @default 1024
   */
  criticalThresholdMb?: number
}

/**
 * Health check for memory usage.
 */
export class MemoryCheck extends HealthCheck {
  readonly name: string

  private thresholdMb: number
  private criticalThresholdMb: number

  constructor(options: MemoryCheckOptions = {}) {
    super()
    this.name = options.name ?? 'memory'
    this.thresholdMb = options.thresholdMb ?? 512
    this.criticalThresholdMb = options.criticalThresholdMb ?? 1024
  }

  async check(): Promise<CheckResult> {
    const usage = process.memoryUsage()
    const usedMb = Math.round(usage.heapUsed / 1024 / 1024)
    const totalMb = Math.round(usage.heapTotal / 1024 / 1024)
    const rssMb = Math.round(usage.rss / 1024 / 1024)

    const meta = {
      usedMb,
      totalMb,
      rssMb,
      thresholdMb: this.thresholdMb,
      criticalThresholdMb: this.criticalThresholdMb,
    }

    if (usedMb >= this.criticalThresholdMb) {
      return this.unhealthy(
        `Memory usage critical: ${usedMb}MB (threshold: ${this.criticalThresholdMb}MB)`,
        meta
      )
    }

    if (usedMb >= this.thresholdMb) {
      return this.degraded(
        `Memory usage elevated: ${usedMb}MB (threshold: ${this.thresholdMb}MB)`,
        meta
      )
    }

    return this.healthy(`Memory usage normal: ${usedMb}MB`, meta)
  }
}
