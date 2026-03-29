import type { CheckResult, HealthStatus } from '../types'
import { HealthCheck } from '../HealthCheck'

/**
 * Callback for custom health check.
 */
export type CustomCheckCallback = () => Promise<{
  status: HealthStatus
  message?: string
  meta?: Record<string, unknown>
}>

/**
 * Custom health check with callback.
 */
export class CustomCheck extends HealthCheck {
  readonly name: string

  private callback: CustomCheckCallback

  constructor(name: string, callback: CustomCheckCallback) {
    super()
    this.name = name
    this.callback = callback
  }

  async check(): Promise<CheckResult> {
    try {
      const result = await this.callback()

      switch (result.status) {
        case 'healthy':
          return this.healthy(result.message, result.meta)
        case 'degraded':
          return this.degraded(result.message, result.meta)
        case 'unhealthy':
          return this.unhealthy(result.message, result.meta)
        default:
          return this.unhealthy('Unknown status returned from check')
      }
    } catch (error) {
      return this.unhealthy(
        error instanceof Error
          ? error.message
          : 'Custom check failed'
      )
    }
  }
}

/**
 * Create a custom health check.
 */
export function customCheck(
  name: string,
  callback: CustomCheckCallback
): CustomCheck {
  return new CustomCheck(name, callback)
}
