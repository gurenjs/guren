import type { TaskDefinition } from './types'
import { isDue, isDueInTimezone } from './CronParser'

export class ScheduledTask {
  private readonly definition: TaskDefinition
  private lastRun: Date | null = null
  /** Start of the invocation holding the overlap guard; null when idle. */
  private runningSince: number | null = null

  constructor(definition: TaskDefinition) {
    this.definition = definition
  }

  getName(): string {
    return this.definition.name ?? 'anonymous'
  }

  getExpression(): string {
    return this.definition.expression
  }

  getTimezone(): string | undefined {
    return this.definition.timezone
  }

  isDue(date: Date = new Date()): boolean {
    if (this.definition.timezone) {
      return isDueInTimezone(this.definition.expression, this.definition.timezone, date)
    }
    return isDue(this.definition.expression, date)
  }

  async shouldRun(): Promise<boolean> {
    if (this.definition.when) {
      const result = await this.definition.when()
      if (!result) {
        return false
      }
    }

    if (this.definition.skip) {
      const result = await this.definition.skip()
      if (result) {
        return false
      }
    }

    return true
  }

  /**
   * `now` is the instant the overlap guard is judged against; a fixed clock can
   * be handed in. Resolves false when the guard or `when`/`skip` declined.
   */
  async run(now: Date = new Date()): Promise<boolean> {
    // Judged before the first await, so two runs started in one tick cannot both pass.
    if (this.definition.withoutOverlapping && this.isRunningAt(now.getTime())) {
      return false
    }

    // Only the start that claimed the guard releases it: a run that outlived
    // `overlapExpiresAt` must not clear the flag of its successor.
    const startedAt = now.getTime()
    this.runningSince = startedAt

    if (!(await this.shouldRun())) {
      this.releaseIfOwner(startedAt)
      return false
    }

    let error: Error | null = null

    try {
      if (this.definition.before) {
        await this.definition.before()
      }

      await this.definition.callback()
      this.lastRun = new Date()

      if (this.definition.onSuccess) {
        await this.definition.onSuccess()
      }
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err))

      if (this.definition.onFailure) {
        await this.definition.onFailure(error)
      }
    } finally {
      this.releaseIfOwner(startedAt)

      if (this.definition.after) {
        await this.definition.after()
      }
    }

    if (error) {
      throw error
    }
    return true
  }

  private isRunningAt(now: number): boolean {
    if (this.runningSince === null) return false
    const expiresAt = this.definition.overlapExpiresAt
    if (expiresAt === undefined) return true
    return now - this.runningSince < expiresAt
  }

  private releaseIfOwner(startedAt: number): void {
    if (this.runningSince === startedAt) {
      this.runningSince = null
    }
  }

  getLastRun(): Date | null {
    return this.lastRun
  }

  isCurrentlyRunning(): boolean {
    return this.runningSince !== null
  }

  getDefinition(): TaskDefinition {
    return { ...this.definition }
  }
}
