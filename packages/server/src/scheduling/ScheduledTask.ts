import type { TaskDefinition } from './types'
import { isDue, isDueInTimezone } from './CronParser'

export class ScheduledTask {
  private readonly definition: TaskDefinition
  private lastRun: Date | null = null
  /**
   * The invocation holding the overlap guard; null when idle. The token is an
   * object rather than `startedAt`: two runs handed the same fixed clock share
   * a millisecond, and the later one would then release the earlier one's guard.
   */
  private running: { token: object; startedAt: number } | null = null

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

  /** `now` is the instant the overlap guard is judged against; a fixed clock can be handed in. */
  async run(now: Date = new Date()): Promise<void> {
    await this.tryRun(now)
  }

  /** {@link run}, resolving false when the overlap guard or `when`/`skip` declined. */
  async tryRun(now: Date = new Date()): Promise<boolean> {
    // Judged before the first await, so two runs started in one tick cannot both pass.
    if (this.definition.withoutOverlapping && this.isRunningAt(now.getTime())) {
      return false
    }

    // Only the start that claimed the guard releases it: a run that outlived
    // `overlapExpiresAt` must not clear the flag of its successor.
    const token = {}
    this.running = { token, startedAt: now.getTime() }

    let shouldRun: boolean
    try {
      shouldRun = await this.shouldRun()
    } catch (error) {
      // A rejecting when()/skip() would otherwise leave the guard held, so the
      // task never runs again under preventOverlapping().
      this.releaseIfOwner(token)
      throw error
    }

    if (!shouldRun) {
      this.releaseIfOwner(token)
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
      this.releaseIfOwner(token)

      if (this.definition.after) {
        await this.definition.after()
      }
    }

    if (error) {
      throw error
    }
    return true
  }

  /** The guard stops blocking once `overlapExpiresAt` milliseconds have elapsed, not after. */
  private isRunningAt(now: number): boolean {
    if (this.running === null) return false
    const expiresAt = this.definition.overlapExpiresAt
    if (expiresAt === undefined) return true
    return now - this.running.startedAt < expiresAt
  }

  private releaseIfOwner(token: object): void {
    if (this.running?.token === token) {
      this.running = null
    }
  }

  getLastRun(): Date | null {
    return this.lastRun
  }

  isCurrentlyRunning(): boolean {
    return this.running !== null
  }

  getDefinition(): TaskDefinition {
    return { ...this.definition }
  }
}
