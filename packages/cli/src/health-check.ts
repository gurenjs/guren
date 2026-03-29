import { consola } from 'consola'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export interface HealthCheckOptions {
  /**
   * Application root directory.
   */
  appRoot?: string

  /**
   * Path to the health setup file.
   */
  health?: string

  /**
   * Run specific checks only.
   */
  checks?: string

  /**
   * Output as JSON.
   */
  json?: boolean
}

type HealthStatus = 'healthy' | 'degraded' | 'unhealthy'

interface CheckResult {
  name: string
  status: HealthStatus
  message?: string
  duration?: number
  meta?: Record<string, unknown>
}

interface HealthReport {
  status: HealthStatus
  timestamp: Date
  checks: CheckResult[]
}

interface HealthManager {
  check(): Promise<HealthReport>
  checkOnly(names: string[]): Promise<HealthReport>
  getCheckNames(): string[]
}

/**
 * Try to load the health manager from common locations.
 */
async function loadHealthManager(options: HealthCheckOptions = {}): Promise<HealthManager | null> {
  const appRoot = options.appRoot ? resolve(options.appRoot) : process.cwd()

  // Common health setup file locations
  const healthPaths = options.health
    ? [resolve(appRoot, options.health)]
    : [
        resolve(appRoot, 'app/health.ts'),
        resolve(appRoot, 'app/Health.ts'),
        resolve(appRoot, 'src/health.ts'),
        resolve(appRoot, 'src/Health.ts'),
        resolve(appRoot, 'config/health.ts'),
      ]

  for (const healthPath of healthPaths) {
    if (existsSync(healthPath)) {
      try {
        const mod = await import(pathToFileURL(healthPath).href)

        // Look for common export patterns
        const health =
          mod.health ||
          mod.healthManager ||
          mod.default

        if (health && typeof health.check === 'function') {
          return health as HealthManager
        }
      } catch (error) {
        consola.debug(`Failed to load health from ${healthPath}:`, error)
      }
    }
  }

  return null
}

/**
 * Get status icon.
 */
function getStatusIcon(status: HealthStatus): string {
  switch (status) {
    case 'healthy':
      return '[OK]'
    case 'degraded':
      return '[WARN]'
    case 'unhealthy':
      return '[FAIL]'
  }
}

/**
 * Get status color.
 */
function getStatusColor(status: HealthStatus): string {
  switch (status) {
    case 'healthy':
      return '\x1b[32m' // green
    case 'degraded':
      return '\x1b[33m' // yellow
    case 'unhealthy':
      return '\x1b[31m' // red
  }
}

const RESET = '\x1b[0m'

/**
 * Run health checks from CLI.
 */
export async function runHealthCheck(options: HealthCheckOptions = {}): Promise<void> {
  const health = await loadHealthManager(options)

  if (!health) {
    consola.info('No health manager found.')
    consola.info('')
    consola.info('To configure health checks, create a health file at:')
    consola.info('  app/health.ts')
    consola.info('')
    consola.info('Example:')
    consola.info('  import { createHealthManager, DatabaseCheck, MemoryCheck } from "@guren/core"')
    consola.info('')
    consola.info('  export const health = createHealthManager()')
    consola.info('  health.register(new DatabaseCheck(db))')
    consola.info('  health.register(new MemoryCheck())')

    // Run basic built-in checks even without config
    await runBasicChecks(options)
    return
  }

  // Get checks to run
  let report: HealthReport

  if (options.checks) {
    const checkNames = options.checks.split(',').map((s) => s.trim())
    report = await health.checkOnly(checkNames)
  } else {
    report = await health.check()
  }

  // Output
  if (options.json) {
    console.log(JSON.stringify({
      status: report.status,
      timestamp: report.timestamp.toISOString(),
      checks: report.checks,
    }, null, 2))
  } else {
    printReport(report)
  }

  // Exit with appropriate code
  if (report.status === 'unhealthy') {
    process.exit(1)
  }
}

/**
 * Run basic health checks without configuration.
 */
async function runBasicChecks(options: HealthCheckOptions): Promise<void> {
  consola.info('')
  consola.info('Running basic health checks...')
  consola.info('')

  const checks: CheckResult[] = []

  // Memory check
  const memoryUsage = process.memoryUsage()
  const usedMb = Math.round(memoryUsage.heapUsed / 1024 / 1024)
  const totalMb = Math.round(memoryUsage.heapTotal / 1024 / 1024)

  checks.push({
    name: 'memory',
    status: usedMb < 512 ? 'healthy' : usedMb < 1024 ? 'degraded' : 'unhealthy',
    message: `Heap: ${usedMb}MB / ${totalMb}MB`,
    meta: { usedMb, totalMb },
  })

  // Process uptime check
  const uptime = process.uptime()
  checks.push({
    name: 'process',
    status: 'healthy',
    message: `Uptime: ${Math.round(uptime)}s`,
    meta: { uptimeSeconds: uptime },
  })

  // Node version check
  checks.push({
    name: 'runtime',
    status: 'healthy',
    message: `Bun/Node ${process.version}`,
    meta: { version: process.version, platform: process.platform },
  })

  const overallStatus = checks.some((c) => c.status === 'unhealthy')
    ? 'unhealthy'
    : checks.some((c) => c.status === 'degraded')
      ? 'degraded'
      : 'healthy'

  const report: HealthReport = {
    status: overallStatus,
    timestamp: new Date(),
    checks,
  }

  if (options.json) {
    console.log(JSON.stringify({
      status: report.status,
      timestamp: report.timestamp.toISOString(),
      checks: report.checks,
    }, null, 2))
  } else {
    printReport(report)
  }
}

/**
 * Print health report to console.
 */
function printReport(report: HealthReport): void {
  console.log('')
  console.log('Health Check Report')
  console.log('===================')
  console.log('')

  const statusColor = getStatusColor(report.status)
  console.log(`Status: ${statusColor}${report.status}${RESET}`)
  console.log(`Timestamp: ${report.timestamp.toISOString()}`)
  console.log('')
  console.log('Checks:')

  for (const check of report.checks) {
    const icon = getStatusIcon(check.status)
    const color = getStatusColor(check.status)
    const duration = check.duration !== undefined ? ` (${check.duration}ms)` : ''

    console.log(`  ${color}${icon}${RESET} ${check.name}${duration}`)
    if (check.message) {
      console.log(`       ${check.message}`)
    }
    console.log('')
  }

  const passing = report.checks.filter((c) => c.status === 'healthy').length
  const total = report.checks.length
  console.log(`Overall: ${passing}/${total} checks passing`)
}
