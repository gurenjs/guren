import { consola } from 'consola'
import { resolve } from 'node:path'
import { lstat, stat } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { isDefinitelyAbsent } from './discovery'

export interface HealthCheckOptions {
  appRoot?: string
  /** Path to the health setup file. */
  health?: string
  /** Comma-separated names; runs only those checks. */
  checks?: string
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
 * The load failures, as report entries: only logged, they would not reach
 * `--json`, leaving the payload indistinguishable from an all-passing app.
 */
function configChecks(loadErrors: string[]): CheckResult[] {
  return loadErrors.map((message) => ({
    name: 'health-config',
    status: 'unhealthy' as const,
    message: `Could not load health checks — ${message}`,
  }))
}

/**
 * A key equal for two paths naming the same file. `stat` first, so a symlink
 * and its target dedupe; `lstat` covers a dangling one, whose own inode still
 * separates two broken links. `bigint` because a Windows file ID is 64 bits
 * (same reason as `isSameFile()` in `agent-harness.ts`). `undefined` means
 * neither probe answered, and the caller then keeps the candidate.
 */
async function fileIdentity(path: string): Promise<string | undefined> {
  for (const probe of [stat, lstat]) {
    try {
      const stats = await probe(path, { bigint: true })
      return `${stats.dev}:${stats.ino}`
    } catch {
      // intentionally empty
    }
  }
  return undefined
}

async function loadHealthManager(
  options: HealthCheckOptions = {},
  loadErrors: string[] = [],
): Promise<HealthManager | null> {
  const appRoot = options.appRoot ? resolve(options.appRoot) : process.cwd()

  const fail = (path: string, reason: string): void => {
    loadErrors.push(`${path}: ${reason}`)
    consola.warn(`Failed to load health checks from ${path}: ${reason}`)
  }

  // A named `--health <path>` makes every failure reportable; without one the
  // list below is a search, so a candidate exporting no manager stays silent.
  // One value carries that distinction rather than a separate mode flag: a
  // bare `--health=` (citty's empty string) turned strictness on while the
  // paths fell back to the search, exiting 1 on an app that otherwise exits 0.
  const namedPath = options.health ? resolve(appRoot, options.health) : undefined
  const healthPaths = namedPath
    ? [namedPath]
    : [
        resolve(appRoot, 'app/health.ts'),
        resolve(appRoot, 'app/Health.ts'),
        resolve(appRoot, 'src/health.ts'),
        resolve(appRoot, 'src/Health.ts'),
        resolve(appRoot, 'config/health.ts'),
      ]

  const seen = new Set<string>()

  for (const healthPath of healthPaths) {
    // `isDefinitelyAbsent`, not `existsSync`: the latter answers "no" for a
    // dangling symlink, an untraversable parent, and an `app` that is a
    // regular file, so a health file the user really put there would be
    // skipped and the command would report a clean bill of health.
    if (await isDefinitelyAbsent(appRoot, healthPath)) {
      if (namedPath !== undefined) fail(namedPath, 'no such file')
      continue
    }

    // By identity, not name: on a case-insensitive filesystem `app/health.ts`
    // and `app/Health.ts` are one file, imported and reported twice. Not by
    // error text either — two different files can fail with the same message.
    const identity = await fileIdentity(healthPath)
    if (identity !== undefined) {
      if (seen.has(identity)) continue
      seen.add(identity)
    }

    try {
      const mod = await import(pathToFileURL(healthPath).href)

      // Shape-tested rather than truthy-tested: a placeholder `health` beside
      // a real `healthManager` would otherwise decide the answer alone.
      const health = [mod.health, mod.healthManager, mod.default].find(
        (candidate) => candidate && typeof candidate.check === 'function',
      )

      if (health) return health as HealthManager

      if (namedPath !== undefined) {
        fail(
          healthPath,
          'imported, but exports no health manager '
          + '(expected `health`, `healthManager`, or a default export with a check() method)',
        )
      }
    } catch (error) {
      // Warned rather than `consola.debug`'d (invisible at the default level)
      // so a file that exists and throws is not reported as no file at all.
      fail(healthPath, error instanceof Error ? error.message : String(error))
    }
  }

  return null
}

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

/** Run health checks from CLI. */
export async function runHealthCheck(options: HealthCheckOptions = {}): Promise<void> {
  const loadErrors: string[] = []
  const health = await loadHealthManager(options, loadErrors)

  // A health file that exists and cannot be imported is not an app with no
  // health checks: the built-in checks would report `healthy` off
  // memory/uptime/runtime alone. `consola.error` goes to stderr, so this
  // never reaches the JSON document.
  if (loadErrors.length > 0) {
    consola.error('Health checks could not be read:')
    for (const message of loadErrors) {
      consola.error(`  ${message}`)
    }
  } else if (!health) {
    sayer(options)([
      'No health manager found.',
      '',
      'To configure health checks, create a health file at:',
      '  app/health.ts',
      '',
      'Example:',
      '  import { createHealthManager, DatabaseCheck, MemoryCheck } from "@guren/core"',
      '',
      '  export const health = createHealthManager()',
      '  health.register(new DatabaseCheck(db))',
      '  health.register(new MemoryCheck())',
    ])
  }

  const report = withLoadErrors(
    health ? await runManagerChecks(health, options) : await runBasicChecks(options),
    loadErrors,
  )

  emit(report, options)

  if (report.status === 'unhealthy') {
    process.exit(1)
  }
}

/**
 * Info-level prose, dropped under `--json`: consola's info reporter writes to
 * stdout, so prose would land in front of the document and break parsing.
 */
function sayer(options: HealthCheckOptions): (lines: string[]) => void {
  return (lines) => {
    if (options.json) return
    for (const line of lines) consola.info(line)
  }
}

/** The configured manager's report, normalized. */
async function runManagerChecks(
  health: HealthManager,
  options: HealthCheckOptions,
): Promise<HealthReport> {
  const report = options.checks
    ? await health.checkOnly(options.checks.split(',').map((name) => name.trim()))
    : await health.check()

  // The manager is app-authored and arrives through `import()`, so nothing
  // type-checks its report; normalized here so no consumer has to defend.
  // `status` is left as given: coercing an unrecognized one would decide the
  // exit code on the command's behalf.
  return {
    ...report,
    checks: Array.isArray(report.checks) ? report.checks : [],
    timestamp: report.timestamp instanceof Date ? report.timestamp : new Date(),
  }
}

/**
 * The report with any load failures folded in. One place, so the manager path
 * and the built-in path cannot disagree about how a load failure is marked.
 */
function withLoadErrors(report: HealthReport, loadErrors: string[]): HealthReport {
  if (loadErrors.length === 0) return report

  return {
    ...report,
    status: 'unhealthy',
    checks: [...configChecks(loadErrors), ...report.checks],
  }
}

/** The one place a report reaches the user. */
function emit(report: HealthReport, options: HealthCheckOptions): void {
  if (options.json) {
    console.log(JSON.stringify({
      status: report.status,
      timestamp: report.timestamp.toISOString(),
      checks: report.checks,
    }, null, 2))
    return
  }

  printReport(report)
}

/**
 * The built-in checks, for an app that configured none of its own. Returns
 * rather than emits: the caller folds load failures in and does the one emit.
 */
async function runBasicChecks(options: HealthCheckOptions): Promise<HealthReport> {
  sayer(options)(['', 'Running basic health checks...', ''])

  const checks: CheckResult[] = []

  const memoryUsage = process.memoryUsage()
  const usedMb = Math.round(memoryUsage.heapUsed / 1024 / 1024)
  const totalMb = Math.round(memoryUsage.heapTotal / 1024 / 1024)

  checks.push({
    name: 'memory',
    status: usedMb < 512 ? 'healthy' : usedMb < 1024 ? 'degraded' : 'unhealthy',
    message: `Heap: ${usedMb}MB / ${totalMb}MB`,
    meta: { usedMb, totalMb },
  })

  const uptime = process.uptime()
  checks.push({
    name: 'process',
    status: 'healthy',
    message: `Uptime: ${Math.round(uptime)}s`,
    meta: { uptimeSeconds: uptime },
  })

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

  return { status: overallStatus, timestamp: new Date(), checks }
}

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
