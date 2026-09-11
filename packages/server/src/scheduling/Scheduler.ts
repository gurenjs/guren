import type { SchedulerLock, SchedulerOptions } from './types'
import { Schedule } from './Schedule'
import { ScheduledTask } from './ScheduledTask'
import { MemorySchedulerLock } from './MemorySchedulerLock'
import { warnOnce } from '../support/warn-once'
import { claimHotDisposable, isHotReloadRuntime, type HotDisposableClaim } from '../hot-reload/hot-disposables'

/**
 * How long a tick's `runOnOneServer()` claim stays held. It is never released
 * after a completed run: a release would let a server whose clock reaches the
 * same minute later re-run the tick. An hour outlives any realistic clock skew.
 */
export const ONE_SERVER_LOCK_TTL_SECONDS = 3600

/** Prefixes every `runOnOneServer()` key; two apps sharing one store must not share it. */
export const DEFAULT_ONE_SERVER_LOCK_PREFIX = 'schedule:'

export class Scheduler {
  private tasks: ScheduledTask[] = []
  private readonly options: Required<Omit<SchedulerOptions, 'lock'>>
  private readonly lock: SchedulerLock
  /** False when the lock is the implicit single-process default, which cannot span servers. */
  private readonly lockWasGiven: boolean
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
      lockPrefix: options.lockPrefix ?? DEFAULT_ONE_SERVER_LOCK_PREFIX,
    }
    this.lockWasGiven = options.lock !== undefined
    this.lock = options.lock ?? new MemorySchedulerLock()
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
   * @throws When a task calls `runOnOneServer()` without a name to key the lock on.
   */
  async runDueTasks(date: Date = new Date()): Promise<void> {
    this.assertOneServerTasksAreNamed(date)
    this.warnIfOneServerTasksShareTheDefaultLock()

    const results = await Promise.allSettled(this.getDueTasks(date).map((task) => this.runTask(task, date)))
    for (const result of results) {
      // runTask() reports its own failures; a rejection here is the reporting
      // itself throwing, which would otherwise be swallowed by allSettled.
      if (result.status === 'rejected') this.options.logger(`Scheduler error: ${describe(result.reason)}`)
    }
  }

  private async runTask(task: ScheduledTask, date: Date): Promise<void> {
    const lockKey = task.getDefinition().onOneServer ? this.oneServerLockKey(task, date) : null

    if (lockKey !== null) {
      let acquired: boolean
      try {
        acquired = await this.lock.acquire(lockKey, ONE_SERVER_LOCK_TTL_SECONDS)
      } catch (error) {
        // Reported as a lock failure, not a task failure: the task never ran.
        this.options.logger(`Lock failed: ${task.getName()} - ${describe(error)}`)
        return
      }
      if (!acquired) {
        this.options.logger(`Task skipped, another server holds it: ${task.getName()}`)
        return
      }
    }

    this.options.logger(`Running task: ${task.getName()}`)

    let ran: boolean
    try {
      ran = await task.tryRun(date)
    } catch (error) {
      this.options.logger(`Task failed: ${task.getName()} - ${describe(error)}`)
      return
    }

    if (ran) {
      this.options.logger(`Task completed: ${task.getName()}`)
      return
    }

    // This server declined (overlap guard, `when`/`skip`); give the tick back
    // so another server may still run it.
    this.options.logger(`Task skipped: ${task.getName()}`)
    if (lockKey !== null) await this.releaseLock(lockKey, task)
  }

  private async releaseLock(lockKey: string, task: ScheduledTask): Promise<void> {
    try {
      await this.lock.release(lockKey)
    } catch (error) {
      this.options.logger(`Lock release failed: ${task.getName()} - ${describe(error)}`)
    }
  }

  /**
   * Same on every server for the same task and minute; the minute is UTC epoch,
   * so timezones cannot split it. Null when the task has no name to key on.
   */
  private oneServerLockKey(task: ScheduledTask, date: Date): string | null {
    const { name } = task.getDefinition()
    if (name === undefined || name === '') return null
    return `${this.options.lockPrefix}${name}:${Math.floor(date.getTime() / 60000)}`
  }

  /** Judged through {@link oneServerLockKey}, so the refusal and the key cannot disagree. */
  private assertOneServerTasksAreNamed(date: Date): void {
    const unnamed = this.tasks.filter(
      (task) => task.getDefinition().onOneServer && this.oneServerLockKey(task, date) === null,
    )
    if (unnamed.length === 0) return

    throw new Error(
      `${unnamed.length} scheduled task(s) call runOnOneServer() without a name. ` +
        'The lock is keyed on the name, so give each one a non-empty .name() before scheduling it.',
    )
  }

  private warnIfOneServerTasksShareTheDefaultLock(): void {
    if (this.lockWasGiven) return
    if (!this.tasks.some((task) => task.getDefinition().onOneServer)) return

    warnOnce(
      'scheduler-default-one-server-lock',
      '[guren] Scheduled task(s) call runOnOneServer() and the scheduler was given no lock, so it is ' +
        'using an in-process MemorySchedulerLock. That holds for one process only: on a second server the ' +
        'task runs again. Pass createScheduler({ lock }) a shared SchedulerLock (RedisSchedulerLock) for a ' +
        'multi-server deploy.',
    )
  }

  /** @throws When a task calls `runOnOneServer()` without a name to key the lock on. */
  start(): void {
    if (this.isRunning) {
      return
    }

    this.assertOneServerTasksAreNamed(new Date())
    this.warnIfOneServerTasksShareTheDefaultLock()

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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
