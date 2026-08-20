import { consola } from 'consola'
import { resolve } from 'node:path'
import { lstat, stat } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { isDefinitelyAbsent } from './discovery'

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
 * The load failures, as report entries.
 *
 * Carried as checks rather than only logged, so they reach `--json` — the
 * shape CI and agents read. Without them the payload is indistinguishable
 * from an app whose health checks all passed.
 */
function configChecks(loadErrors: string[]): CheckResult[] {
  return loadErrors.map((message) => ({
    name: 'health-config',
    status: 'unhealthy' as const,
    message: `Could not load health checks — ${message}`,
  }))
}

/**
 * A key that is equal for two paths naming the same file, and different
 * otherwise.
 *
 * `stat` first, so a symlink and its target dedupe to one candidate. It
 * throws for a *dangling* symlink, and falling back to the literal path there
 * defeated the dedupe in exactly the case the loader was taught to notice:
 * `app/health.ts` and `app/Health.ts` pointing nowhere are one file on a
 * case-insensitive filesystem, and were reported twice. The link itself is a
 * real inode, so `lstat` answers for it — and keeps two genuinely different
 * broken links apart, which a path-shaped fallback could not.
 *
 * `bigint` because a Windows file ID is 64 bits and would not survive a
 * `number` — two distinct files could compare equal and one of their failures
 * go unreported. Same reason `isSameFile()` in `agent-harness.ts` uses it.
 *
 * `undefined` means neither probe could answer; the caller keeps the
 * candidate rather than guessing, since a duplicate report is a smaller
 * failure than a dropped one.
 */
async function fileIdentity(path: string): Promise<string | undefined> {
  for (const probe of [stat, lstat]) {
    try {
      const stats = await probe(path, { bigint: true })
      return `${stats.dev}:${stats.ino}`
    } catch {
      // the next probe answers, or nothing does
    }
  }
  return undefined
}

/**
 * Try to load the health manager from common locations.
 */
async function loadHealthManager(
  options: HealthCheckOptions = {},
  loadErrors: string[] = [],
): Promise<HealthManager | null> {
  const appRoot = options.appRoot ? resolve(options.appRoot) : process.cwd()

  const fail = (path: string, reason: string): void => {
    loadErrors.push(`${path}: ${reason}`)
    consola.warn(`Failed to load health checks from ${path}: ${reason}`)
  }

  // A `--health <path>` is the user naming the file; anything that stops it
  // from yielding a manager is a failure to report, including the file not
  // being there and the file exporting nothing recognizable. Without one, the
  // list below is a *search*, so a candidate that loads without exporting a
  // manager is just a miss — some other `health.ts` — and stays silent.
  //
  // One value carries that distinction rather than a mode flag beside the
  // list, because a flag and a list derived from the same option disagreed:
  // `--health=` (citty's result for a valued flag given no value) turned on
  // named-file strictness while the paths fell back to the default search,
  // and exited 1 on an app that exits 0 without the flag. An empty value
  // names no file.
  //
  // `resolveRoutesFile()` derives namedness the same way and for the same
  // reason, but is not shared with this: there, absence when unnamed is a
  // silent shape and the whole answer; here it is one candidate of five, and
  // the named case additionally has to report a file that imports but exports
  // nothing. The atom the two have in common is `Boolean(option)` — the
  // consequences are what differ, and those do not factor.
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

  // Probing and importing in one pass, so the usual app — a manager at the
  // first candidate — stops there instead of stat'ing all five first. Dedupe
  // is incremental for the same reason: a candidate is only ever compared
  // against ones already reached, which is what a two-phase pass computed
  // anyway.
  const seen = new Set<string>()

  for (const healthPath of healthPaths) {
    // `isDefinitelyAbsent`, not `existsSync`: the latter answers "no" for a
    // dangling symlink, an untraversable parent, and an `app` that is a
    // regular file — so a health file the user really put there would be
    // skipped, and the command would report a clean bill of health for a
    // configuration it never managed to look at.
    if (await isDefinitelyAbsent(appRoot, healthPath)) {
      if (namedPath !== undefined) fail(namedPath, 'no such file')
      continue
    }

    // Deduped by identity, not by name: on a case-insensitive filesystem
    // `app/health.ts` and `app/Health.ts` are one file, and the loop would
    // otherwise import it twice and report the same failure twice. Deduping
    // on the *error text* instead would collapse two genuinely different
    // files whose failures happen to read alike (a `throw new Error('boom')`
    // in each carries no path), under-reporting a real second problem.
    const identity = await fileIdentity(healthPath)
    if (identity !== undefined) {
      if (seen.has(identity)) continue
      seen.add(identity)
    }

    try {
      const mod = await import(pathToFileURL(healthPath).href)

      // Each candidate export is tested for the shape, not just for being
      // truthy: a file that exports both a placeholder `health` and a real
      // `healthManager` would otherwise be judged on the placeholder alone and
      // reported as exporting no manager.
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
      // `consola.debug` is invisible at the default log level, so a health
      // file that exists and throws on import used to arrive at the caller as
      // `null` — rendered as "No health manager found", followed by
      // instructions to create the file the user already has. Reported as a
      // warning, and remembered so the caller can say which file failed
      // instead of claiming there is none.
      fail(healthPath, error instanceof Error ? error.message : String(error))
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
  const loadErrors: string[] = []
  const health = await loadHealthManager(options, loadErrors)

  // A health file that exists and cannot be imported is not an app with no
  // health checks. Both used to reach the built-in checks, which report
  // `status: "healthy"` off memory/uptime/runtime alone — so `guren
  // health:check --json` answered a question it had not been able to ask.
  // Printed once, because `loadErrors` is complete the moment the loader
  // returns; `consola.error` goes to stderr, so it never reaches the JSON.
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
 * Info-level prose, dropped under `--json`.
 *
 * consola's info reporter writes to stdout, so under `--json` prose lands in
 * front of the document and nothing downstream can parse it. One gate for
 * every prose block in this command, so a later message cannot forget it —
 * which is the bug this exists to fix. (It looked fine from the test suite
 * only because `NODE_ENV=test` puts consola at warn level: the assertion was
 * reading the environment.)
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
  // type-checks the report it returns. A missing `checks` reached
  // `printReport` as "undefined is not an object" and the splice below as a
  // spread of undefined; a missing `timestamp` is the same crash one field
  // over, at every `toISOString()`. Normalized where the value crosses the
  // boundary, so no consumer downstream has to defend. `status` is left as
  // given: coercing an unrecognized one would decide the exit code on the
  // command's behalf.
  return {
    ...report,
    checks: Array.isArray(report.checks) ? report.checks : [],
    timestamp: report.timestamp instanceof Date ? report.timestamp : new Date(),
  }
}

/**
 * The report with any load failures folded in.
 *
 * One place, because the two paths into it used to disagree: the built-in
 * checks derived `unhealthy` from a spliced entry while the manager path
 * forced it, and only one of them reported at all — so a broken
 * `app/health.ts` beside a working leftover answered `"status": "healthy"`,
 * exit 0, with the failure's only trace a stderr warning a CI step reading
 * stdout never sees.
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
 * The built-in checks, for an app that configured none of its own.
 *
 * Returns rather than emits: the caller folds load failures in and does the
 * one emit, so the two ways into a report cannot disagree about how a failure
 * is marked or which exit code follows.
 */
async function runBasicChecks(options: HealthCheckOptions): Promise<HealthReport> {
  sayer(options)(['', 'Running basic health checks...', ''])

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

  return { status: overallStatus, timestamp: new Date(), checks }
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
