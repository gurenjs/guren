export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy'

export interface CheckResult {
  name: string
  status: HealthStatus
  message?: string
  meta?: Record<string, unknown>
  duration: number // milliseconds
}

export interface HealthReport {
  status: HealthStatus
  timestamp: Date
  checks: CheckResult[]
  meta?: Record<string, unknown>
}

export interface HealthCheckOptions {
  /**
   * Milliseconds.
   * @default 5000
   */
  timeout?: number

  /**
   * Failure sets the whole report's status to unhealthy.
   * @default false
   */
  critical?: boolean
}

export interface HealthMiddlewareOptions {
  /** Run only these checks, by name. */
  checks?: string[]

  /** @default true */
  detailed?: boolean
}
