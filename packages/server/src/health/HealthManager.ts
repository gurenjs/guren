import type { Context } from '../http/Application'
import type { Middleware } from '../http/middleware'
import type {
  HealthReport,
  CheckResult,
  HealthCheckOptions,
  HealthMiddlewareOptions,
  HealthStatus,
} from './types'
import type { HealthCheck } from './HealthCheck'

interface RegisteredCheck {
  check: HealthCheck
  options: HealthCheckOptions
}

/**
 * Health check manager.
 */
export class HealthManager {
  private checks: Map<string, RegisteredCheck> = new Map()

  /**
   * Register a health check.
   */
  register(check: HealthCheck, options: HealthCheckOptions = {}): this {
    this.checks.set(check.name, {
      check,
      options: {
        timeout: options.timeout ?? 5000,
        critical: options.critical ?? false,
      },
    })
    return this
  }

  /**
   * Unregister a health check.
   */
  unregister(name: string): this {
    this.checks.delete(name)
    return this
  }

  /**
   * Get all registered check names.
   */
  getCheckNames(): string[] {
    return Array.from(this.checks.keys())
  }

  /**
   * Run all health checks.
   */
  async check(): Promise<HealthReport> {
    return this.runChecks(this.getCheckNames())
  }

  /**
   * Run specific health checks.
   */
  async checkOnly(names: string[]): Promise<HealthReport> {
    const validNames = names.filter((name) => this.checks.has(name))
    return this.runChecks(validNames)
  }

  /**
   * Get a specific check result.
   */
  async getCheck(name: string): Promise<CheckResult | null> {
    const registered = this.checks.get(name)
    if (!registered) {
      return null
    }
    return this.runCheck(registered)
  }

  /**
   * Create middleware for health endpoints.
   */
  middleware(options: HealthMiddlewareOptions = {}): Middleware {
    return async (ctx: Context, next: () => Promise<void>): Promise<void> => {
      const report = options.checks
        ? await this.checkOnly(options.checks)
        : await this.check()

      const statusCode =
        report.status === 'healthy'
          ? 200
          : report.status === 'degraded'
            ? 200
            : 503

      // Finalize the context by assigning `ctx.res`. `ctx.json()` only builds a
      // Response; a handler that returns undefined without setting one makes the
      // router synthesize an empty 204, dropping the report entirely.
      if (options.detailed === false) {
        ctx.res = ctx.json(
          {
            status: report.status,
            timestamp: report.timestamp.toISOString(),
          },
          statusCode,
        )
        return
      }
      ctx.res = ctx.json(
        {
          status: report.status,
          timestamp: report.timestamp.toISOString(),
          checks: report.checks.map((check) => ({
            name: check.name,
            status: check.status,
            message: check.message,
            duration: check.duration,
            meta: check.meta,
          })),
        },
        statusCode,
      )
    }
  }

  /**
   * Run the specified checks.
   */
  private async runChecks(names: string[]): Promise<HealthReport> {
    const results: CheckResult[] = []
    let overallStatus: HealthStatus = 'healthy'

    await Promise.all(
      names.map(async (name) => {
        const registered = this.checks.get(name)
        if (!registered) return

        const result = await this.runCheck(registered)
        results.push(result)

        // Update overall status
        if (result.status === 'unhealthy') {
          if (registered.options.critical) {
            overallStatus = 'unhealthy'
          } else if (overallStatus !== 'unhealthy') {
            overallStatus = 'degraded'
          }
        } else if (
          result.status === 'degraded' &&
          overallStatus === 'healthy'
        ) {
          overallStatus = 'degraded'
        }
      })
    )

    // Sort results by name for consistent output
    results.sort((a, b) => a.name.localeCompare(b.name))

    return {
      status: overallStatus,
      timestamp: new Date(),
      checks: results,
    }
  }

  /**
   * Run a single check with timeout.
   */
  private async runCheck(registered: RegisteredCheck): Promise<CheckResult> {
    const { check, options } = registered
    const start = performance.now()

    try {
      const result = await Promise.race([
        check.check(),
        this.timeoutPromise(options.timeout!),
      ])

      result.duration = Math.round(performance.now() - start)
      return result
    } catch (error) {
      const duration = Math.round(performance.now() - start)
      return {
        name: check.name,
        status: 'unhealthy',
        message:
          error instanceof Error ? error.message : 'Check failed with error',
        duration,
      }
    }
  }

  /**
   * Create a timeout promise.
   */
  private timeoutPromise(ms: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Health check timed out after ${ms}ms`))
      }, ms)
    })
  }
}

/**
 * Create a health manager.
 */
export function createHealthManager(): HealthManager {
  return new HealthManager()
}
