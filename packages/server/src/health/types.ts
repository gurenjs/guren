/**
 * Health check status.
 */
export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy'

/**
 * Result of a single health check.
 */
export interface CheckResult {
  name: string
  status: HealthStatus
  message?: string
  meta?: Record<string, unknown>
  duration: number // milliseconds
}

/**
 * Complete health report.
 */
export interface HealthReport {
  status: HealthStatus
  timestamp: Date
  checks: CheckResult[]
  meta?: Record<string, unknown>
}

/**
 * Options for registering a health check.
 */
export interface HealthCheckOptions {
  /**
   * Timeout in milliseconds for the check.
   * @default 5000
   */
  timeout?: number

  /**
   * If true, failure of this check will set overall status to unhealthy.
   * @default false
   */
  critical?: boolean
}

/**
 * Options for health middleware.
 */
export interface HealthMiddlewareOptions {
  /**
   * Only run these specific checks.
   */
  checks?: string[]

  /**
   * Include detailed check results.
   * @default true
   */
  detailed?: boolean
}
