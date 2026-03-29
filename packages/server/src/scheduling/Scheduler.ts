import type { SchedulerOptions } from './types'
import { Schedule } from './Schedule'
import { ScheduledTask } from './ScheduledTask'

/**
 * Task scheduler for running periodic tasks.
 *
 * @example
 * ```ts
 * const scheduler = new Scheduler()
 *
 * scheduler.schedule((schedule) => {
 *   schedule.call(async () => {
 *     await cleanupOldSessions()
 *   }).daily().at('03:00').name('cleanup-sessions')
 *
 *   schedule.job(SendWeeklyDigestJob, {})
 *     .weekly()
 *     .sundays()
 *     .at('09:00')
 *     .tz('Asia/Tokyo')
 * })
 *
 * scheduler.start()
 * ```
 */
export class Scheduler {
  private tasks: ScheduledTask[] = []
  private readonly options: Required<SchedulerOptions>
  private interval: ReturnType<typeof setInterval> | null = null
  private isRunning = false
  private lastCheck: Date | null = null

  constructor(options: SchedulerOptions = {}) {
    this.options = {
      timezone: options.timezone ?? 'UTC',
      checkInterval: options.checkInterval ?? 60000,
      logger: options.logger ?? (() => {}),
    }
  }

  /**
   * Define schedules using a callback.
   */
  schedule(definer: (schedule: Schedule) => void): void {
    const schedule = new Schedule()
    definer(schedule)
    this.tasks.push(...schedule.buildTasks())
  }

  /**
   * Add a pre-built task.
   */
  addTask(task: ScheduledTask): void {
    this.tasks.push(task)
  }

  /**
   * Get all scheduled tasks.
   */
  getTasks(): ScheduledTask[] {
    return [...this.tasks]
  }

  /**
   * Get tasks that are due now.
   */
  getDueTasks(date: Date = new Date()): ScheduledTask[] {
    return this.tasks.filter((task) => task.isDue(date))
  }

  /**
   * Run all due tasks.
   */
  async runDueTasks(date: Date = new Date()): Promise<void> {
    const dueTasks = this.getDueTasks(date)

    for (const task of dueTasks) {
      this.options.logger(`Running task: ${task.getName()}`)

      try {
        await task.run()
        this.options.logger(`Task completed: ${task.getName()}`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.options.logger(`Task failed: ${task.getName()} - ${message}`)
      }
    }
  }

  /**
   * Start the scheduler.
   */
  start(): void {
    if (this.isRunning) {
      return
    }

    this.isRunning = true
    this.options.logger('Scheduler started')

    // Run immediately
    this.tick()

    // Set up interval
    this.interval = setInterval(() => {
      this.tick()
    }, this.options.checkInterval)

    // Prevent keeping the process alive
    if (this.interval.unref) {
      this.interval.unref()
    }
  }

  /**
   * Stop the scheduler.
   */
  stop(): void {
    if (!this.isRunning) {
      return
    }

    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }

    this.isRunning = false
    this.options.logger('Scheduler stopped')
  }

  /**
   * Check and run due tasks.
   */
  private tick(): void {
    const now = new Date()

    // Only check once per minute
    if (this.lastCheck) {
      const lastMinute = Math.floor(this.lastCheck.getTime() / 60000)
      const currentMinute = Math.floor(now.getTime() / 60000)

      if (lastMinute === currentMinute) {
        return
      }
    }

    this.lastCheck = now
    this.runDueTasks(now).catch((error) => {
      this.options.logger(`Scheduler error: ${error}`)
    })
  }

  /**
   * Check if the scheduler is running.
   */
  getIsRunning(): boolean {
    return this.isRunning
  }

  /**
   * Get the check interval.
   */
  getCheckInterval(): number {
    return this.options.checkInterval
  }

  /**
   * Get the default timezone.
   */
  getTimezone(): string {
    return this.options.timezone
  }

  /**
   * Clear all tasks.
   */
  clear(): void {
    this.tasks = []
  }

  /**
   * Get the number of tasks.
   */
  count(): number {
    return this.tasks.length
  }

  /**
   * Get task by name.
   */
  getTask(name: string): ScheduledTask | undefined {
    return this.tasks.find((task) => task.getName() === name)
  }

  /**
   * Remove a task by name.
   */
  removeTask(name: string): boolean {
    const index = this.tasks.findIndex((task) => task.getName() === name)
    if (index !== -1) {
      this.tasks.splice(index, 1)
      return true
    }
    return false
  }
}

/**
 * Create a scheduler instance.
 */
export function createScheduler(options?: SchedulerOptions): Scheduler {
  return new Scheduler(options)
}
