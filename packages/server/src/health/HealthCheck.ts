import type { CheckResult, HealthStatus } from './types'

export abstract class HealthCheck {
  abstract readonly name: string

  abstract check(): Promise<CheckResult>

  protected healthy(
    message?: string,
    meta?: Record<string, unknown>
  ): CheckResult {
    return this.result('healthy', message, meta)
  }

  protected degraded(
    message?: string,
    meta?: Record<string, unknown>
  ): CheckResult {
    return this.result('degraded', message, meta)
  }

  protected unhealthy(
    message?: string,
    meta?: Record<string, unknown>
  ): CheckResult {
    return this.result('unhealthy', message, meta)
  }

  protected handleError(error: unknown, fallbackMessage: string): CheckResult {
    return this.unhealthy(
      error instanceof Error ? error.message : fallbackMessage
    )
  }

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
