import { consola } from 'consola'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

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

/** Loads the schedule kernel from `--kernel`, or from the conventional locations. */
async function loadScheduleKernel(options: ScheduleOptions = {}): Promise<{ tasks: TaskInfo[]; scheduler?: unknown } | null> {
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

  for (const kernelPath of kernelPaths) {
    if (existsSync(kernelPath)) {
      try {
        const mod = await import(pathToFileURL(kernelPath).href)

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

function getNextRunTime(expression: string, timezone?: string): Date | null {
  try {
    const parts = expression.split(' ')
    if (parts.length !== 5) return null

    const now = new Date()
    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts

    // Estimation only: covers the common patterns, not the full cron grammar.
    const next = new Date(now)

    if (minute === '*' && hour === '*') {
      next.setMinutes(next.getMinutes() + 1)
      next.setSeconds(0)
    } else if (minute !== '*' && hour === '*') {
      const targetMinute = parseInt(minute, 10)
      if (next.getMinutes() >= targetMinute) {
        next.setHours(next.getHours() + 1)
      }
      next.setMinutes(targetMinute)
      next.setSeconds(0)
    } else if (minute !== '*' && hour !== '*') {
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
  console.log(`Total: ${kernel.tasks.length} task${kernel.tasks.length === 1 ? '' : 's'}`)
}

export async function runScheduledTasks(options: ScheduleRunOptions = {}): Promise<void> {
  const kernel = await loadScheduleKernel(options)

  if (!kernel || kernel.tasks.length === 0) {
    consola.error('No scheduled tasks found.')
    return
  }

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
