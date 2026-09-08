import { consola } from 'consola'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDefinitelyAbsent } from './discovery'
import { createScheduler, matchesCron, parseCron, toTimezone, type ParsedCron, type Scheduler } from '@guren/core'

export interface ScheduleOptions {
  appRoot?: string
  kernel?: string
  json?: boolean
}

export interface ScheduleRunOptions extends ScheduleOptions {
  /** Run only the task with this name. */
  task?: string
  /** Run regardless of whether the task is due. */
  force?: boolean
}

interface TaskInfo {
  name: string
  expression: string
  timezone?: string
  nextRun?: Date
  /** Execute the task (bound to ScheduledTask.run() when available). */
  run?: () => Promise<void>
  /** Whether the cron expression matches the given time. */
  isDue?: (date: Date) => boolean
}

type ScheduledTaskLike = {
  getName?: () => string
  getExpression?: () => string
  getTimezone?: () => string | undefined
  run?: () => Promise<void>
  isDue?: (date?: Date) => boolean
  toTask?: () => ScheduledTaskLike
  name?: string
  expression?: string
  timezone?: string
  callback?: () => void | Promise<void>
}

function normalizeTask(raw: ScheduledTaskLike): TaskInfo {
  // PendingSchedule -> ScheduledTask
  const task = typeof raw.toTask === 'function' ? raw.toTask() : raw

  if (typeof task.getName === 'function' && typeof task.getExpression === 'function') {
    return {
      name: task.getName(),
      expression: task.getExpression(),
      timezone: task.getTimezone?.(),
      run: typeof task.run === 'function' ? () => task.run!() : undefined,
      isDue: typeof task.isDue === 'function' ? (date) => task.isDue!(date) : undefined,
    }
  }

  // Plain TaskDefinition
  return {
    name: task.name || 'unnamed',
    expression: task.expression || '* * * * *',
    timezone: task.timezone,
    run: typeof task.callback === 'function' ? async () => { await task.callback!() } : undefined,
  }
}

/** Why a listing has no tasks; see {@link reportEmptyKernel} for what each state means. */
type KernelLoad =
  | { kind: 'loaded'; path: string; tasks: TaskInfo[]; warnings: string[] }
  | { kind: 'missing' }
  | { kind: 'not-found'; path: string }
  | { kind: 'failed'; path: string; reasons: string[] }
  | { kind: 'unrecognized'; path: string; exports: string[] }

/** Export names carrying a kernel factory: called with no scheduler, returns the schedule. */
const KERNEL_FACTORY_EXPORTS = ['scheduleTasksKernel', 'schedule', 'defineSchedule', 'default']

/**
 * Export names carrying a registrar: handed the scheduler, returns nothing. Named
 * rather than shape-matched, for the reason `route-registrar.ts` gives about routes
 * — a helper that merely takes one argument is not the entry point, and a loader
 * that calls every such export runs app code nobody pointed it at.
 */
const REGISTRAR_PATTERN = /^register\w*Schedules$/u

function isRegistrarExportName(name: string): boolean {
  return name === 'default' || REGISTRAR_PATTERN.test(name)
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function tasksFromSchedule(value: unknown): TaskInfo[] | null {
  const schedule = value as { buildTasks?: () => unknown[]; getTasks?: () => unknown[] } | null
  const raw =
    typeof schedule?.buildTasks === 'function'
      ? schedule.buildTasks()
      : typeof schedule?.getTasks === 'function'
        ? schedule.getTasks()
        : null

  return raw ? raw.map((task) => normalizeTask(task as ScheduledTaskLike)) : null
}

/**
 * Reads one kernel module in both shapes the docs teach: a factory returning a
 * `Schedule` (`scheduleTasksKernel()`), and a registrar taking the `Scheduler`
 * the app binds in a provider. Arity is what tells them apart — a registrar's
 * export name belongs to the app, so no name list can find it.
 */
async function readKernelModule(kernelPath: string): Promise<KernelLoad> {
  let mod: Record<string, unknown>
  try {
    mod = (await import(pathToFileURL(kernelPath).href)) as Record<string, unknown>
  } catch (error) {
    return { kind: 'failed', path: kernelPath, reasons: [describeError(error)] }
  }

  const reasons: string[] = []

  for (const name of KERNEL_FACTORY_EXPORTS) {
    const exported = mod[name]
    if (typeof exported !== 'function' || exported.length > 0) continue

    try {
      const tasks = tasksFromSchedule(await (exported as () => unknown)())
      if (tasks) return { kind: 'loaded', path: kernelPath, tasks, warnings: [] }
    } catch (error) {
      reasons.push(`${name}() threw: ${describeError(error)}`)
    }
  }

  // One scheduler across every registrar, so an app may split its tasks over
  // several. Deduplicated by identity: `export default registerSchedules` beside
  // the named export is the same function twice, not two sets of tasks.
  const registrars = new Map<(scheduler: Scheduler) => unknown, string>()
  for (const [name, exported] of Object.entries(mod)) {
    if (typeof exported === 'function' && exported.length === 1 && isRegistrarExportName(name)) {
      const registrar = exported as (scheduler: Scheduler) => unknown
      if (!registrars.has(registrar)) registrars.set(registrar, name)
    }
  }

  if (registrars.size > 0) {
    const scheduler = createScheduler()
    for (const [registrar, name] of registrars) {
      try {
        await registrar(scheduler)
      } catch (error) {
        reasons.push(`${name}(scheduler) threw: ${describeError(error)}`)
      }
    }

    // The `await` above is what keeps an async registrar's rejection reportable
    // rather than escaping as an unhandled one.
    const tasks = scheduler.getTasks().map((task) => normalizeTask(task as ScheduledTaskLike))
    if (tasks.length > 0 || reasons.length === 0) {
      return { kind: 'loaded', path: kernelPath, tasks, warnings: reasons }
    }
  }

  if (reasons.length > 0) return { kind: 'failed', path: kernelPath, reasons }
  return { kind: 'unrecognized', path: kernelPath, exports: Object.keys(mod) }
}

/** Loads the schedule kernel from `--kernel`, or from the conventional locations. */
async function loadScheduleKernel(options: ScheduleOptions = {}): Promise<KernelLoad> {
  const appRoot = options.appRoot ? resolve(options.appRoot) : process.cwd()

  const kernelPaths = options.kernel
    ? [resolve(appRoot, options.kernel)]
    : [
        resolve(appRoot, 'app/Console/Kernel.ts'),
        resolve(appRoot, 'app/Console/kernel.ts'),
        resolve(appRoot, 'app/console/Kernel.ts'),
        resolve(appRoot, 'app/console/kernel.ts'),
        resolve(appRoot, 'src/Console/Kernel.ts'),
        resolve(appRoot, 'src/console/Kernel.ts'),
      ]

  let firstProblem: KernelLoad | null = null

  for (const kernelPath of kernelPaths) {
    // Loader semantics: a kernel whose directory cannot be read must reach the
    // import and be diagnosed, not be reported as an app that has no kernel.
    if (await isDefinitelyAbsent(appRoot, kernelPath)) continue

    const load = await readKernelModule(kernelPath)
    if (load.kind === 'loaded') return load
    firstProblem ??= load
  }

  if (firstProblem) return firstProblem
  return options.kernel ? { kind: 'not-found', path: kernelPaths[0] } : { kind: 'missing' }
}

/**
 * How far ahead a "next run" is searched. Four years covers a Feb 29 task;
 * a day-of-week + Feb 29 combination past that shows as "-" in the listing.
 */
const NEXT_RUN_HORIZON_MS = 4 * 366 * 24 * 60 * 60 * 1000

/**
 * The next instant at which the scheduler would fire `expression`. Mirrors
 * `ScheduledTask.isDue()`: a timezone-bearing task is matched against its wall
 * clock in that zone, the rest against local time — a second estimator lists a
 * local-time run for a task fired on Tokyo time. Steps an hour while the hour or
 * day cannot match, then a minute; an hour step only skips minutes a DST gap removed.
 */
export function getNextRunTime(
  expression: string,
  timezone?: string,
  from: Date = new Date(),
): Date | null {
  let cron: ParsedCron
  try {
    cron = parseCron(expression)
  } catch {
    return null
  }
  // A field outside its range ("0 25 * * *") parses to no values at all.
  if (Object.values(cron).some((values) => values.length === 0)) return null

  const wallClock = (instant: Date): Date => (timezone ? toTimezone(instant, timezone) : instant)
  const dayMatches = (wall: Date): boolean =>
    cron.dayOfMonth.includes(wall.getDate()) &&
    cron.month.includes(wall.getMonth() + 1) &&
    cron.dayOfWeek.includes(wall.getDay())

  const next = new Date(from)
  next.setSeconds(0, 0)
  next.setMinutes(next.getMinutes() + 1)

  const horizon = from.getTime() + NEXT_RUN_HORIZON_MS

  try {
    while (next.getTime() <= horizon) {
      const wall = wallClock(next)
      if (matchesCron(wall, cron)) return next

      const stepMinutes =
        cron.hour.includes(wall.getHours()) && dayMatches(wall) ? 1 : 60 - wall.getMinutes()
      next.setTime(next.getTime() + stepMinutes * 60_000)
    }
  } catch {
    // An unknown timezone throws from Intl; the listing shows "-" for it.
    return null
  }

  return null
}

function formatTimeUntil(date: Date): string {
  const now = new Date()
  const diff = date.getTime() - now.getTime()

  if (diff < 0) return 'now'

  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) return `in ${days} day${days === 1 ? '' : 's'}`
  if (hours > 0) return `in ${hours} hour${hours === 1 ? '' : 's'}`
  if (minutes > 0) return `in ${minutes} min${minutes === 1 ? '' : 's'}`
  return 'in < 1 min'
}

/**
 * Says why there are no tasks to show. `missing` is the only state the "create a
 * kernel" hint fits: a kernel that exists but threw, exported nothing usable, or
 * was named by a `--kernel` that is not there, is a wiring bug, and the hint would
 * answer a question nobody asked. Diagnostics go through consola's error/warn
 * (stderr), leaving `--json` stdout machine-readable.
 */
function reportEmptyKernel(kernel: KernelLoad, json: boolean): void {
  switch (kernel.kind) {
    case 'not-found':
      consola.error(`No schedule kernel at ${kernel.path}.`)
      process.exitCode = 1
      return

    case 'failed':
      consola.error(
        [`Failed to load the schedule kernel at ${kernel.path}:`, ...kernel.reasons.map((reason) => `  ${reason}`)].join('\n'),
      )
      process.exitCode = 1
      return

    case 'unrecognized':
      consola.error(
        [
          `${kernel.path} exports nothing the scheduler recognizes.`,
          `  Found: ${kernel.exports.join(', ') || '(no exports)'}`,
          '  Export a kernel factory `scheduleTasksKernel(): Schedule`, or a registrar',
          '  named `register…Schedules(scheduler: Scheduler)`. Either may be the default export.',
        ].join('\n'),
      )
      process.exitCode = 1
      return

    case 'loaded':
      consola.warn(`${kernel.path} loaded, but registered no tasks.`)
      return

    case 'missing':
      if (json) return
      consola.info('No scheduled tasks found.')
      consola.info('')
      consola.info('To define scheduled tasks, create a kernel file at:')
      consola.info('  app/Console/Kernel.ts')
      consola.info('')
      consola.info('Example:')
      consola.info('  export function scheduleTasksKernel() {')
      consola.info('    const schedule = new Schedule()')
      consola.info('    schedule.call(myTask).daily().name("my-task")')
      consola.info('    return schedule')
      consola.info('  }')
  }
}

/**
 * The kernel's tasks, or `null` once the reason there are none has been reported.
 * `reportEmptyKernel`'s `loaded` case relies on the emptiness test here, so the two
 * stay in one place.
 */
async function resolveTasks(options: ScheduleOptions): Promise<TaskInfo[] | null> {
  const kernel = await loadScheduleKernel(options)

  if (kernel.kind !== 'loaded' || kernel.tasks.length === 0) {
    reportEmptyKernel(kernel, Boolean(options.json))
    return null
  }

  for (const warning of kernel.warnings) consola.warn(warning)
  return kernel.tasks
}

export async function listScheduledTasks(options: ScheduleOptions = {}): Promise<void> {
  const tasks = await resolveTasks(options)

  if (!tasks) {
    if (options.json) console.log(JSON.stringify([], null, 2))
    return
  }

  if (options.json) {
    const data = tasks.map((task) => {
      const nextRun = getNextRunTime(task.expression, task.timezone)
      return {
        name: task.name,
        expression: task.expression,
        nextRun: nextRun ? nextRun.toISOString() : null,
        timezone: task.timezone || 'UTC',
      }
    })
    console.log(JSON.stringify(data, null, 2))
    return
  }

  const rows: string[][] = []

  for (const task of tasks) {
    const nextRun = getNextRunTime(task.expression, task.timezone)
    rows.push([
      task.name,
      task.expression,
      nextRun ? formatTimeUntil(nextRun) : '-',
      task.timezone || 'UTC',
    ])
  }

  console.log('')
  console.log('Scheduled Tasks')
  console.log('================')
  console.log('')

  const headers = ['Name', 'Expression', 'Next Run', 'Timezone']
  const colWidths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length))
  )

  console.log(headers.map((h, i) => h.padEnd(colWidths[i])).join('  '))
  console.log(colWidths.map((w) => '-'.repeat(w)).join('  '))

  for (const row of rows) {
    console.log(row.map((c, i) => c.padEnd(colWidths[i])).join('  '))
  }

  console.log('')
  console.log(`Total: ${tasks.length} task${tasks.length === 1 ? '' : 's'}`)
}

export async function runScheduledTasks(options: ScheduleRunOptions = {}): Promise<void> {
  const tasks = await resolveTasks(options)
  if (!tasks) return

  const tasksToRun = options.task ? tasks.filter((t) => t.name === options.task) : tasks

  if (tasksToRun.length === 0) {
    consola.error(`Task "${options.task}" not found.`)
    return
  }

  if (options.force) {
    consola.info(`Running ${tasksToRun.length} task(s) (forced)...`)
  } else {
    consola.info(`Checking ${tasksToRun.length} task(s) for due execution...`)
  }

  const now = new Date()
  let failures = 0

  for (const task of tasksToRun) {
    const due = options.force || (task.isDue ? task.isDue(now) : false)

    if (!due) {
      const nextRun = getNextRunTime(task.expression, task.timezone)
      consola.info(`  Not due: ${task.name}${nextRun ? ` (${formatTimeUntil(nextRun)})` : ''}`)
      continue
    }

    if (!task.run) {
      consola.warn(`  Cannot run: ${task.name} (no runnable callback found)`)
      continue
    }

    try {
      const startedAt = Date.now()
      await task.run()
      consola.success(`  Ran: ${task.name} (${Date.now() - startedAt}ms)`)
    } catch (error) {
      failures += 1
      consola.error(`  Failed: ${task.name} — ${describeError(error)}`)
    }
  }

  if (failures > 0) {
    process.exitCode = 1
  }
}
