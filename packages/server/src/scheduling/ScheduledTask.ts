import type { TaskDefinition } from './types'
import { isDue, isDueInTimezone } from './CronParser'

export class ScheduledTask {
  private readonly definition: TaskDefinition
  private lastRun: Date | null = null
  private isRunning = false

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

  async run(): Promise<void> {
    // Check overlapping first (synchronously) to prevent race conditions
    if (this.definition.withoutOverlapping) {
      if (this.isRunning) {
        return
      }
      this.isRunning = true
    }

    if (!(await this.shouldRun())) {
      if (this.definition.withoutOverlapping) {
        this.isRunning = false
      }
      return
    }

    if (!this.definition.withoutOverlapping) {
      this.isRunning = true
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
      this.isRunning = false

      if (this.definition.after) {
        await this.definition.after()
      }
    }

    if (error) {
      throw error
    }
  }

  getLastRun(): Date | null {
    return this.lastRun
  }

  isCurrentlyRunning(): boolean {
    return this.isRunning
  }

  getDefinition(): TaskDefinition {
    return { ...this.definition }
  }
}
