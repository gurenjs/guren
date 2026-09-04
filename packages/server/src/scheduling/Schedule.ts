import type { TaskCallback, TaskDefinition, JobClass } from './types'
import { ScheduledTask } from './ScheduledTask'

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

  everyMinute(): this {
    this.expression = '* * * * *'
    return this
  }

  everyTwoMinutes(): this {
    this.expression = '*/2 * * * *'
    return this
  }

  everyThreeMinutes(): this {
    this.expression = '*/3 * * * *'
    return this
  }

  everyFourMinutes(): this {
    this.expression = '*/4 * * * *'
    return this
  }

  everyFiveMinutes(): this {
    this.expression = '*/5 * * * *'
    return this
  }

  everyTenMinutes(): this {
    this.expression = '*/10 * * * *'
    return this
  }

  everyFifteenMinutes(): this {
    this.expression = '*/15 * * * *'
    return this
  }

  everyThirtyMinutes(): this {
    this.expression = '*/30 * * * *'
    return this
  }

  hourly(): this {
    this.expression = '0 * * * *'
    return this
  }

  hourlyAt(minute: number): this {
    this.expression = `${minute} * * * *`
    return this
  }

  everyTwoHours(): this {
    this.expression = '0 */2 * * *'
    return this
  }

  everyThreeHours(): this {
    this.expression = '0 */3 * * *'
    return this
  }

  everyFourHours(): this {
    this.expression = '0 */4 * * *'
    return this
  }

  everySixHours(): this {
    this.expression = '0 */6 * * *'
    return this
  }

  daily(): this {
    this.expression = '0 0 * * *'
    return this
  }

  dailyAt(time: string): this {
    const [hour, minute] = time.split(':').map((n) => parseInt(n, 10))
    this.expression = `${minute ?? 0} ${hour ?? 0} * * *`
    return this
  }

  at(time: string): this {
    return this.dailyAt(time)
  }

  twiceDaily(firstHour = 1, secondHour = 13): this {
    this.expression = `0 ${firstHour},${secondHour} * * *`
    return this
  }

  weekly(): this {
    this.expression = '0 0 * * 0'
    return this
  }

  /** `day`: cron day-of-week, 0 = Sunday. */
  weeklyOn(day: number, time = '00:00'): this {
    const [hour, minute] = time.split(':').map((n) => parseInt(n, 10))
    this.expression = `${minute ?? 0} ${hour ?? 0} * * ${day}`
    return this
  }

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

  weekdays(): this {
    const parts = this.expression.split(' ')
    parts[4] = '1-5'
    this.expression = parts.join(' ')
    return this
  }

  weekends(): this {
    const parts = this.expression.split(' ')
    parts[4] = '0,6'
    this.expression = parts.join(' ')
    return this
  }

  monthly(): this {
    this.expression = '0 0 1 * *'
    return this
  }

  monthlyOn(day: number, time = '00:00'): this {
    const [hour, minute] = time.split(':').map((n) => parseInt(n, 10))
    this.expression = `${minute ?? 0} ${hour ?? 0} ${day} * *`
    return this
  }

  lastDayOfMonth(time = '00:00'): this {
    // This is approximate - 28-31 covers most cases
    const [hour, minute] = time.split(':').map((n) => parseInt(n, 10))
    this.expression = `${minute ?? 0} ${hour ?? 0} 28-31 * *`
    return this
  }

  quarterly(): this {
    this.expression = '0 0 1 1,4,7,10 *'
    return this
  }

  yearly(): this {
    this.expression = '0 0 1 1 *'
    return this
  }

  yearlyOn(month: number, day: number, time = '00:00'): this {
    const [hour, minute] = time.split(':').map((n) => parseInt(n, 10))
    this.expression = `${minute ?? 0} ${hour ?? 0} ${day} ${month} *`
    return this
  }

  cron(expression: string): this {
    this.expression = expression
    return this
  }

  name(name: string): this {
    this.taskName = name
    return this
  }

  tz(timezone: string): this {
    this.timezone = timezone
    return this
  }

  setTimezone(timezone: string): this {
    return this.tz(timezone)
  }

  preventOverlapping(expiresAt?: number): this {
    this.withoutOverlapping = true
    this.overlapExpiresAt = expiresAt
    return this
  }

  withoutOverlaps(expiresAt?: number): this {
    return this.preventOverlapping(expiresAt)
  }

  runOnOneServer(): this {
    this.onOneServer = true
    return this
  }

  when(callback: () => boolean | Promise<boolean>): this {
    this.whenCallback = callback
    return this
  }

  skip(callback: () => boolean | Promise<boolean>): this {
    this.skipCallback = callback
    return this
  }

  before(callback: () => void | Promise<void>): this {
    this.beforeCallback = callback
    return this
  }

  after(callback: () => void | Promise<void>): this {
    this.afterCallback = callback
    return this
  }

  onSuccess(callback: () => void | Promise<void>): this {
    this.successCallback = callback
    return this
  }

  onFailure(callback: (error: Error) => void | Promise<void>): this {
    this.failureCallback = callback
    return this
  }

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

  toTask(): ScheduledTask {
    return new ScheduledTask(this.build())
  }
}

export class Schedule {
  private readonly tasks: PendingSchedule[] = []

  call(callback: TaskCallback): PendingSchedule {
    const pending = new PendingSchedule(callback)
    this.tasks.push(pending)
    return pending
  }

  job<T>(jobClass: JobClass<T>, payload: T): PendingSchedule {
    return this.call(async () => {
      await jobClass.dispatch(payload)
    })
  }

  command(cmd: string): PendingSchedule {
    return this.call(async () => {
      const { exec } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const execAsync = promisify(exec)
      await execAsync(cmd)
    })
  }

  getPendingSchedules(): PendingSchedule[] {
    return [...this.tasks]
  }

  buildTasks(): ScheduledTask[] {
    return this.tasks.map((pending) => pending.toTask())
  }
}
