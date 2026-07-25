import type { SchedulerOptions } from './types'
import { Schedule } from './Schedule'
import { ScheduledTask } from './ScheduledTask'
import { claimHotDisposable, isHotReloadRuntime, type HotDisposableClaim } from '../hot-reload/hot-disposables'

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
  /** This scheduler's claim on its hot-reload slot while it is running. */
  private hotReloadClaim: HotDisposableClaim | undefined

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

    // Under `bun --hot`, stop the scheduler the previous evaluation started —
    // otherwise both tick, and every scheduled task runs twice per reload.
    // Keyed on frame 2 of this stack: whoever called `start()`.
    this.hotReloadClaim = claimHotDisposable(
      'scheduler',
      isHotReloadRuntime() ? new Error().stack : undefined,
      this.options.timezone,
      () => this.stop(),
    )

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

    // Give the slot up: a stopped scheduler left holding one keeps itself, and
    // every task it has been given, reachable from `globalThis` for the rest of
    // the process — the same leak this registry exists to close. Also reached as
    // the registry's own teardown, where the slot already belongs to the
    // replacement and this is a no-op.
    this.hotReloadClaim?.release()
    this.hotReloadClaim = undefined

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
