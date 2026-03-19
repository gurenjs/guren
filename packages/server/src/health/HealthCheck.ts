import type { CheckResult, HealthStatus } from './types'

/**
 * Abstract base class for health checks.
 */
export abstract class HealthCheck {
  /**
   * The name of this health check.
   */
  abstract readonly name: string

  /**
   * Perform the health check.
   */
  abstract check(): Promise<CheckResult>

  /**
   * Create a healthy result.
   */
  protected healthy(
    message?: string,
    meta?: Record<string, unknown>
  ): CheckResult {
    return this.result('healthy', message, meta)
  }

  /**
   * Create a degraded result.
   */
  protected degraded(
    message?: string,
    meta?: Record<string, unknown>
  ): CheckResult {
    return this.result('degraded', message, meta)
  }

  /**
   * Create an unhealthy result.
   */
  protected unhealthy(
    message?: string,
    meta?: Record<string, unknown>
  ): CheckResult {
    return this.result('unhealthy', message, meta)
  }

  /**
   * Create a check result.
   */
  private result(
    status: HealthStatus,
    message?: string,
    meta?: Record<string, unknown>
  ): CheckResult {
    const result: CheckResult = {
      name: this.name,
      status,
      duration: 0, // Will be set by HealthManager
    }

    if (message !== undefined) {
      result.message = message
    }

    if (meta !== undefined) {
      result.meta = meta
    }

    return result
  }
}
