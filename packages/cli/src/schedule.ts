import { consola } from 'consola'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { matchesCron, parseCron, toTimezone, type ParsedCron } from '@guren/core'

export interface ScheduleOptions {
  /**
   * Application root directory.
   */
  appRoot?: string

  /**
   * Path to the schedule kernel file.
   */
  kernel?: string

  /**
   * Output as JSON.
   */
  json?: boolean
}

export interface ScheduleRunOptions extends ScheduleOptions {
  /**
   * Run a specific task by name.
   */
  task?: string

  /**
   * Force run (ignore schedule).
   */
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

/**
 * Try to load the schedule kernel from common locations.
 */
async function loadScheduleKernel(options: ScheduleOptions = {}): Promise<{ tasks: TaskInfo[]; scheduler?: unknown } | null> {
  const appRoot = options.appRoot ? resolve(options.appRoot) : process.cwd()

  // Common kernel file locations
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

  for (const kernelPath of kernelPaths) {
    if (existsSync(kernelPath)) {
      try {
        const mod = await import(pathToFileURL(kernelPath).href)

        // Look for common export patterns
        const scheduleFunction =
          mod.scheduleTasksKernel ||
          mod.schedule ||
          mod.defineSchedule ||
          mod.default

        if (typeof scheduleFunction === 'function') {
          const schedule = scheduleFunction()

          if (schedule && typeof schedule.buildTasks === 'function') {
            const tasks = schedule.buildTasks()
            return { tasks: tasks.map((t: unknown) => normalizeTask(t as ScheduledTaskLike)) }
          }

          if (schedule && typeof schedule.getTasks === 'function') {
            const tasks = schedule.getTasks()
            return { tasks: tasks.map((t: unknown) => normalizeTask(t as ScheduledTaskLike)) }
          }
        }
      } catch (error) {
        consola.debug(`Failed to load kernel from ${kernelPath}:`, error)
      }
    }
  }

  return null
}

/**
 * How far ahead a "next run" is searched. Four years covers a Feb 29 task;
 * a day-of-week + Feb 29 combination past that shows as "-" in the listing.
 */
const NEXT_RUN_HORIZON_MS = 4 * 366 * 24 * 60 * 60 * 1000

/**
 * The next instant at which the scheduler would fire `expression`.
 *
 * Mirrors `ScheduledTask.isDue()`: a timezone-bearing task is matched against
 * its wall clock in that zone, the rest against local time. Walking the same
 * predicate forward is what keeps the listed "next run" honest — a second
 * estimator is how the CLI came to announce a local-time run for a task the
 * scheduler fires on Tokyo time.
 *
 * Steps a wall-clock hour at a time while the hour or day cannot match, then
 * a minute at a time. An hour step can only skip wall-clock minutes a DST gap
 * removed, so it never overshoots a real occurrence.
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

/**
 * Format time difference as human readable.
 */
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
 * List all scheduled tasks.
 */
export async function listScheduledTasks(options: ScheduleOptions = {}): Promise<void> {
  const kernel = await loadScheduleKernel(options)

  if (!kernel || kernel.tasks.length === 0) {
    if (options.json) {
      console.log(JSON.stringify([], null, 2))
      return
    }

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
    return
  }

  if (options.json) {
    const data = kernel.tasks.map((task) => {
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

  // Build table data
  const rows: string[][] = []

  for (const task of kernel.tasks) {
    const nextRun = getNextRunTime(task.expression, task.timezone)
    rows.push([
      task.name,
      task.expression,
      nextRun ? formatTimeUntil(nextRun) : '-',
      task.timezone || 'UTC',
    ])
  }

  // Print header
  console.log('')
  console.log('Scheduled Tasks')
  console.log('================')
  console.log('')

  // Print table
  const headers = ['Name', 'Expression', 'Next Run', 'Timezone']
  const colWidths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length))
  )

  // Header row
  console.log(headers.map((h, i) => h.padEnd(colWidths[i])).join('  '))
  console.log(colWidths.map((w) => '-'.repeat(w)).join('  '))

  // Data rows
  for (const row of rows) {
    console.log(row.map((c, i) => c.padEnd(colWidths[i])).join('  '))
  }

  console.log('')
  console.log(`Total: ${kernel.tasks.length} task${kernel.tasks.length === 1 ? '' : 's'}`)
}

/**
 * Run scheduled tasks.
 */
export async function runScheduledTasks(options: ScheduleRunOptions = {}): Promise<void> {
  const kernel = await loadScheduleKernel(options)

  if (!kernel || kernel.tasks.length === 0) {
    consola.error('No scheduled tasks found.')
    return
  }

  // Filter by task name if specified
  const tasksToRun = options.task
    ? kernel.tasks.filter((t) => t.name === options.task)
    : kernel.tasks

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
      const reason = error instanceof Error ? error.message : String(error)
      consola.error(`  Failed: ${task.name} — ${reason}`)
    }
  }

  if (failures > 0) {
    process.exitCode = 1
  }
}
