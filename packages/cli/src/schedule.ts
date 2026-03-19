import { consola } from 'consola'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export interface ScheduleOptions {
  /**
   * Application root directory.
   */
  appRoot?: string

  /**
   * Path to the schedule kernel file.
   */
  kernel?: string
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
            return {
              tasks: tasks.map((t: unknown) => ({
                name: (t as { name?: string }).name || 'unnamed',
                expression: (t as { expression?: string }).expression || '* * * * *',
                timezone: (t as { timezone?: string }).timezone,
              })),
            }
          }

          if (schedule && typeof schedule.getTasks === 'function') {
            const tasks = schedule.getTasks()
            return {
              tasks: tasks.map((t: unknown) => ({
                name: (t as { name?: string }).name || 'unnamed',
                expression: (t as { expression?: string }).expression || '* * * * *',
                timezone: (t as { timezone?: string }).timezone,
              })),
              scheduler: schedule,
            }
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
 * Parse cron expression and get next run time.
 */
function getNextRunTime(expression: string, timezone?: string): Date | null {
  try {
    const parts = expression.split(' ')
    if (parts.length !== 5) return null

    const now = new Date()
    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts

    // Simple estimation for common patterns
    const next = new Date(now)

    if (minute === '*' && hour === '*') {
      // Every minute
      next.setMinutes(next.getMinutes() + 1)
      next.setSeconds(0)
    } else if (minute !== '*' && hour === '*') {
      // Every hour at specific minute
      const targetMinute = parseInt(minute, 10)
      if (next.getMinutes() >= targetMinute) {
        next.setHours(next.getHours() + 1)
      }
      next.setMinutes(targetMinute)
      next.setSeconds(0)
    } else if (minute !== '*' && hour !== '*') {
      // Daily at specific time
      const targetHour = parseInt(hour, 10)
      const targetMinute = parseInt(minute, 10)
      if (
        next.getHours() > targetHour ||
        (next.getHours() === targetHour && next.getMinutes() >= targetMinute)
      ) {
        next.setDate(next.getDate() + 1)
      }
      next.setHours(targetHour)
      next.setMinutes(targetMinute)
      next.setSeconds(0)
    }

    return next
  } catch {
    return null
  }
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

  // Note: In a real implementation, this would integrate with the actual scheduler
  // For now, we just show what would run
  for (const task of tasksToRun) {
    if (options.force) {
      consola.info(`  Would run: ${task.name} (${task.expression})`)
    } else {
      const nextRun = getNextRunTime(task.expression, task.timezone)
      if (nextRun) {
        const diff = nextRun.getTime() - Date.now()
        if (diff <= 60000) {
          // Due within 1 minute
          consola.info(`  Due now: ${task.name}`)
        } else {
          consola.info(`  Not due: ${task.name} (${formatTimeUntil(nextRun)})`)
        }
      }
    }
  }

  consola.info('')
  consola.info('Note: To actually run tasks, integrate with the scheduler in your application.')
}
