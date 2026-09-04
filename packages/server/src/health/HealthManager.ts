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

export class HealthManager {
  private checks: Map<string, RegisteredCheck> = new Map()

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

  unregister(name: string): this {
    this.checks.delete(name)
    return this
  }

  getCheckNames(): string[] {
    return Array.from(this.checks.keys())
  }

  async check(): Promise<HealthReport> {
    return this.runChecks(this.getCheckNames())
  }

  async checkOnly(names: string[]): Promise<HealthReport> {
    const validNames = names.filter((name) => this.checks.has(name))
    return this.runChecks(validNames)
  }

  async getCheck(name: string): Promise<CheckResult | null> {
    const registered = this.checks.get(name)
    if (!registered) {
      return null
    }
    return this.runCheck(registered)
  }

  middleware(options: HealthMiddlewareOptions = {}): Middleware {
    return async (ctx: Context, _next: () => Promise<void>): Promise<void> => {
      const report = options.checks
        ? await this.checkOnly(options.checks)
        : await this.check()

      const statusCode =
        report.status === 'healthy'
          ? 200
          : report.status === 'degraded'
            ? 200
            : 503

      // `ctx.json()` only builds a Response; without assigning `ctx.res` the
      // router synthesizes an empty 204 and the report is dropped.
      ctx.res = ctx.json(
        {
          status: report.status,
          timestamp: report.timestamp.toISOString(),
          ...(options.detailed === false
            ? {}
            : {
                checks: report.checks.map((check) => ({
                  name: check.name,
                  status: check.status,
                  message: check.message,
                  duration: check.duration,
                  meta: check.meta,
                })),
              }),
        },
        statusCode,
      )
    }
  }

  private async runChecks(names: string[]): Promise<HealthReport> {
    const results: CheckResult[] = []
    let overallStatus: HealthStatus = 'healthy'

    await Promise.all(
      names.map(async (name) => {
        const registered = this.checks.get(name)
        if (!registered) return

        const result = await this.runCheck(registered)
        results.push(result)

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

    results.sort((a, b) => a.name.localeCompare(b.name))

    return {
      status: overallStatus,
      timestamp: new Date(),
      checks: results,
    }
  }

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

  private timeoutPromise(ms: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Health check timed out after ${ms}ms`))
      }, ms)
    })
  }
}

export function createHealthManager(): HealthManager {
  return new HealthManager()
}
