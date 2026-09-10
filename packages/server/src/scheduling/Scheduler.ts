import type { SchedulerLock, SchedulerOptions } from './types'
import { Schedule } from './Schedule'
import { ScheduledTask } from './ScheduledTask'
import { claimHotDisposable, isHotReloadRuntime, type HotDisposableClaim } from '../hot-reload/hot-disposables'

/**
 * How long a tick's `runOnOneServer()` claim stays held. It is never released
 * after a completed run: a release would let a server whose clock reaches the
 * same minute later re-run the tick. An hour outlives any realistic clock skew.
 */
export const ONE_SERVER_LOCK_TTL_SECONDS = 3600

export class Scheduler {
  private tasks: ScheduledTask[] = []
  private readonly options: Required<Omit<SchedulerOptions, 'lock'>> & { lock?: SchedulerLock }
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
      lock: options.lock,
    }
  }

  schedule(definer: (schedule: Schedule) => void): void {
    const schedule = new Schedule()
    definer(schedule)
    this.tasks.push(...schedule.buildTasks())
  }

  addTask(task: ScheduledTask): void {
    this.tasks.push(task)
  }

  getTasks(): ScheduledTask[] {
    return [...this.tasks]
  }

  getDueTasks(date: Date = new Date()): ScheduledTask[] {
    return this.tasks.filter((task) => task.isDue(date))
  }

  /**
   * Due tasks run concurrently: awaited one by one, a slow task pushed the rest
   * past their minute, where the tick's once-per-minute check dropped them.
   * Each task's own overlap guard still serialises that task with itself.
   * @throws When a task calls `runOnOneServer()` and no `lock` was configured.
   */
  async runDueTasks(date: Date = new Date()): Promise<void> {
    this.assertOneServerTasksAreLockable()

    await Promise.allSettled(this.getDueTasks(date).map((task) => this.runTask(task, date)))
  }

  private async runTask(task: ScheduledTask, date: Date): Promise<void> {
    const lockKey = task.getDefinition().onOneServer ? this.oneServerLockKey(task, date) : null

    if (lockKey !== null && !(await this.options.lock!.acquire(lockKey, ONE_SERVER_LOCK_TTL_SECONDS))) {
      this.options.logger(`Task skipped, another server holds it: ${task.getName()}`)
      return
    }

    this.options.logger(`Running task: ${task.getName()}`)

    try {
      const ran = await task.run(date)
      if (ran) {
        this.options.logger(`Task completed: ${task.getName()}`)
      } else {
        // This server declined (overlap guard, `when`/`skip`); give the tick
        // back so another server may still run it.
        if (lockKey !== null) await this.options.lock!.release(lockKey)
        this.options.logger(`Task skipped: ${task.getName()}`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.options.logger(`Task failed: ${task.getName()} - ${message}`)
    }
  }

  /** Same on every server for the same task and minute; the minute is UTC epoch, so timezones cannot split it. */
  private oneServerLockKey(task: ScheduledTask, date: Date): string {
    return `schedule:${task.getName()}:${Math.floor(date.getTime() / 60000)}`
  }

  private assertOneServerTasksAreLockable(): void {
    const oneServerTasks = this.tasks.filter((task) => task.getDefinition().onOneServer)
    if (oneServerTasks.length === 0) return

    if (!this.options.lock) {
      const names = oneServerTasks.map((task) => task.getName()).join(', ')
      throw new Error(
        `Scheduled task(s) call runOnOneServer() but the scheduler has no lock: ${names}. ` +
          'Pass createScheduler({ lock }) a SchedulerLock (RedisSchedulerLock for a multi-server deploy, ' +
          'MemorySchedulerLock for a single process), or drop runOnOneServer().',
      )
    }

    const unnamed = oneServerTasks.filter((task) => task.getDefinition().name === undefined)
    if (unnamed.length > 0) {
      throw new Error(
        `${unnamed.length} scheduled task(s) call runOnOneServer() without a name. ` +
          'The lock is keyed on the name, so give each one .name() before scheduling it.',
      )
    }
  }

  /** @throws When a task calls `runOnOneServer()` and no `lock` was configured. */
  start(): void {
    if (this.isRunning) {
      return
    }

    this.assertOneServerTasksAreLockable()

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

    this.tick()

    this.interval = setInterval(() => {
      this.tick()
    }, this.options.checkInterval)

    // Prevent keeping the process alive
    if (this.interval.unref) {
      this.interval.unref()
    }
  }

  stop(): void {
    if (!this.isRunning) {
      return
    }

    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }

    // A stopped scheduler still holding its slot keeps itself and every task it
    // was given reachable from `globalThis`. Also reached as the registry's own
    // teardown, where the slot already belongs to the replacement: a no-op.
    this.hotReloadClaim?.release()
    this.hotReloadClaim = undefined

    this.isRunning = false
    this.options.logger('Scheduler stopped')
  }

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

  getIsRunning(): boolean {
    return this.isRunning
  }

  getCheckInterval(): number {
    return this.options.checkInterval
  }

  getTimezone(): string {
    return this.options.timezone
  }

  clear(): void {
    this.tasks = []
  }

  count(): number {
    return this.tasks.length
  }

  getTask(name: string): ScheduledTask | undefined {
    return this.tasks.find((task) => task.getName() === name)
  }

  removeTask(name: string): boolean {
    const index = this.tasks.findIndex((task) => task.getName() === name)
    if (index !== -1) {
      this.tasks.splice(index, 1)
      return true
    }
    return false
  }
}

export function createScheduler(options?: SchedulerOptions): Scheduler {
  return new Scheduler(options)
}
