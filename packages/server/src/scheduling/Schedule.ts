import type { TaskCallback, TaskDefinition, JobClass } from './types'
import { ScheduledTask } from './ScheduledTask'

/**
 * Pending schedule builder for fluent API.
 */
export class PendingSchedule {
  private expression = '* * * * *'
  private timezone?: string
  private taskName?: string
  private withoutOverlapping = false
  private overlapExpiresAt?: number
  private onOneServer = false
  private whenCallback?: () => boolean | Promise<boolean>
  private skipCallback?: () => boolean | Promise<boolean>
  private beforeCallback?: () => void | Promise<void>
  private afterCallback?: () => void | Promise<void>
  private successCallback?: () => void | Promise<void>
  private failureCallback?: (error: Error) => void | Promise<void>

  constructor(private readonly callback: TaskCallback) {}

  // ===== Frequency Methods =====

  /**
   * Run every minute.
   */
  everyMinute(): this {
    this.expression = '* * * * *'
    return this
  }

  /**
   * Run every two minutes.
   */
  everyTwoMinutes(): this {
    this.expression = '*/2 * * * *'
    return this
  }

  /**
   * Run every three minutes.
   */
  everyThreeMinutes(): this {
    this.expression = '*/3 * * * *'
    return this
  }

  /**
   * Run every four minutes.
   */
  everyFourMinutes(): this {
    this.expression = '*/4 * * * *'
    return this
  }

  /**
   * Run every five minutes.
   */
  everyFiveMinutes(): this {
    this.expression = '*/5 * * * *'
    return this
  }

  /**
   * Run every ten minutes.
   */
  everyTenMinutes(): this {
    this.expression = '*/10 * * * *'
    return this
  }

  /**
   * Run every fifteen minutes.
   */
  everyFifteenMinutes(): this {
    this.expression = '*/15 * * * *'
    return this
  }

  /**
   * Run every thirty minutes.
   */
  everyThirtyMinutes(): this {
    this.expression = '*/30 * * * *'
    return this
  }

  /**
   * Run hourly.
   */
  hourly(): this {
    this.expression = '0 * * * *'
    return this
  }

  /**
   * Run hourly at a specific minute.
   */
  hourlyAt(minute: number): this {
    this.expression = `${minute} * * * *`
    return this
  }

  /**
   * Run every two hours.
   */
  everyTwoHours(): this {
    this.expression = '0 */2 * * *'
    return this
  }

  /**
   * Run every three hours.
   */
  everyThreeHours(): this {
    this.expression = '0 */3 * * *'
    return this
  }

  /**
   * Run every four hours.
   */
  everyFourHours(): this {
    this.expression = '0 */4 * * *'
    return this
  }

  /**
   * Run every six hours.
   */
  everySixHours(): this {
    this.expression = '0 */6 * * *'
    return this
  }

  /**
   * Run daily at midnight.
   */
  daily(): this {
    this.expression = '0 0 * * *'
    return this
  }

  /**
   * Run daily at a specific time.
   * @param time Time in HH:MM format
   */
  dailyAt(time: string): this {
    const [hour, minute] = time.split(':').map((n) => parseInt(n, 10))
    this.expression = `${minute ?? 0} ${hour ?? 0} * * *`
    return this
  }

  /**
   * Alias for dailyAt.
   */
  at(time: string): this {
    return this.dailyAt(time)
  }

  /**
   * Run twice daily.
   */
  twiceDaily(firstHour = 1, secondHour = 13): this {
    this.expression = `0 ${firstHour},${secondHour} * * *`
    return this
  }

  /**
   * Run weekly on Sunday at midnight.
   */
  weekly(): this {
    this.expression = '0 0 * * 0'
    return this
  }

  /**
   * Run weekly on a specific day at a specific time.
   * @param day Day of week (0 = Sunday, 6 = Saturday)
   * @param time Time in HH:MM format
   */
  weeklyOn(day: number, time = '00:00'): this {
    const [hour, minute] = time.split(':').map((n) => parseInt(n, 10))
    this.expression = `${minute ?? 0} ${hour ?? 0} * * ${day}`
    return this
  }

  // Day of week shortcuts

  sundays(): this {
    const parts = this.expression.split(' ')
    parts[4] = '0'
    this.expression = parts.join(' ')
    return this
  }

  mondays(): this {
    const parts = this.expression.split(' ')
    parts[4] = '1'
    this.expression = parts.join(' ')
    return this
  }

  tuesdays(): this {
    const parts = this.expression.split(' ')
    parts[4] = '2'
    this.expression = parts.join(' ')
    return this
  }

  wednesdays(): this {
    const parts = this.expression.split(' ')
    parts[4] = '3'
    this.expression = parts.join(' ')
    return this
  }

  thursdays(): this {
    const parts = this.expression.split(' ')
    parts[4] = '4'
    this.expression = parts.join(' ')
    return this
  }

  fridays(): this {
    const parts = this.expression.split(' ')
    parts[4] = '5'
    this.expression = parts.join(' ')
    return this
  }

  saturdays(): this {
    const parts = this.expression.split(' ')
    parts[4] = '6'
    this.expression = parts.join(' ')
    return this
  }

  /**
   * Run on weekdays (Monday-Friday).
   */
  weekdays(): this {
    const parts = this.expression.split(' ')
    parts[4] = '1-5'
    this.expression = parts.join(' ')
    return this
  }

  /**
   * Run on weekends (Saturday-Sunday).
   */
  weekends(): this {
    const parts = this.expression.split(' ')
    parts[4] = '0,6'
    this.expression = parts.join(' ')
    return this
  }

  /**
   * Run monthly on the first day at midnight.
   */
  monthly(): this {
    this.expression = '0 0 1 * *'
    return this
  }

  /**
   * Run monthly on a specific day at a specific time.
   */
  monthlyOn(day: number, time = '00:00'): this {
    const [hour, minute] = time.split(':').map((n) => parseInt(n, 10))
    this.expression = `${minute ?? 0} ${hour ?? 0} ${day} * *`
    return this
  }

  /**
   * Run on the last day of the month.
   */
  lastDayOfMonth(time = '00:00'): this {
    // This is approximate - 28-31 covers most cases
    const [hour, minute] = time.split(':').map((n) => parseInt(n, 10))
    this.expression = `${minute ?? 0} ${hour ?? 0} 28-31 * *`
    return this
  }

  /**
   * Run quarterly.
   */
  quarterly(): this {
    this.expression = '0 0 1 1,4,7,10 *'
    return this
  }

  /**
   * Run yearly on January 1st at midnight.
   */
  yearly(): this {
    this.expression = '0 0 1 1 *'
    return this
  }

  /**
   * Run yearly on a specific date.
   */
  yearlyOn(month: number, day: number, time = '00:00'): this {
    const [hour, minute] = time.split(':').map((n) => parseInt(n, 10))
    this.expression = `${minute ?? 0} ${hour ?? 0} ${day} ${month} *`
    return this
  }

  /**
   * Set a custom cron expression.
   */
  cron(expression: string): this {
    this.expression = expression
    return this
  }

  // ===== Configuration Methods =====

  /**
   * Set the task name.
   */
  name(name: string): this {
    this.taskName = name
    return this
  }

  /**
   * Set the timezone.
   */
  tz(timezone: string): this {
    this.timezone = timezone
    return this
  }

  /**
   * Alias for tz().
   */
  setTimezone(timezone: string): this {
    return this.tz(timezone)
  }

  /**
   * Prevent overlapping executions.
   */
  preventOverlapping(expiresAt?: number): this {
    this.withoutOverlapping = true
    this.overlapExpiresAt = expiresAt
    return this
  }

  /**
   * Alias for preventOverlapping().
   */
  withoutOverlaps(expiresAt?: number): this {
    return this.preventOverlapping(expiresAt)
  }

  /**
   * Only run on one server.
   */
  runOnOneServer(): this {
    this.onOneServer = true
    return this
  }

  /**
   * Set a condition for running.
   */
  when(callback: () => boolean | Promise<boolean>): this {
    this.whenCallback = callback
    return this
  }

  /**
   * Set a condition to skip execution.
   */
  skip(callback: () => boolean | Promise<boolean>): this {
    this.skipCallback = callback
    return this
  }

  /**
   * Set a before callback.
   */
  before(callback: () => void | Promise<void>): this {
    this.beforeCallback = callback
    return this
  }

  /**
   * Set an after callback.
   */
  after(callback: () => void | Promise<void>): this {
    this.afterCallback = callback
    return this
  }

  /**
   * Set a success callback.
   */
  onSuccess(callback: () => void | Promise<void>): this {
    this.successCallback = callback
    return this
  }

  /**
   * Set a failure callback.
   */
  onFailure(callback: (error: Error) => void | Promise<void>): this {
    this.failureCallback = callback
    return this
  }

  // ===== Build Method =====

  /**
   * Build the task definition.
   */
  build(): TaskDefinition {
    return {
      name: this.taskName,
      expression: this.expression,
      timezone: this.timezone,
      callback: this.callback,
      withoutOverlapping: this.withoutOverlapping,
      overlapExpiresAt: this.overlapExpiresAt,
      onOneServer: this.onOneServer,
      when: this.whenCallback,
      skip: this.skipCallback,
      before: this.beforeCallback,
      after: this.afterCallback,
      onSuccess: this.successCallback,
      onFailure: this.failureCallback,
    }
  }

  /**
   * Build as a ScheduledTask.
   */
  toTask(): ScheduledTask {
    return new ScheduledTask(this.build())
  }
}

/**
 * Schedule builder for defining multiple tasks.
 */
export class Schedule {
  private readonly tasks: PendingSchedule[] = []

  /**
   * Schedule a callback.
   */
  call(callback: TaskCallback): PendingSchedule {
    const pending = new PendingSchedule(callback)
    this.tasks.push(pending)
    return pending
  }

  /**
   * Schedule a job.
   */
  job<T>(jobClass: JobClass<T>, payload: T): PendingSchedule {
    return this.call(async () => {
      await jobClass.dispatch(payload)
    })
  }

  /**
   * Schedule a shell command.
   */
  command(cmd: string): PendingSchedule {
    return this.call(async () => {
      const { exec } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const execAsync = promisify(exec)
      await execAsync(cmd)
    })
  }

  /**
   * Get all pending schedules.
   */
  getPendingSchedules(): PendingSchedule[] {
    return [...this.tasks]
  }

  /**
   * Build all tasks.
   */
  buildTasks(): ScheduledTask[] {
    return this.tasks.map((pending) => pending.toTask())
  }
}
