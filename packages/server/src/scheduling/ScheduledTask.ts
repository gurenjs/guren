import type { TaskDefinition, TaskCallback } from './types'
import { isDue, isDueInTimezone } from './CronParser'

/**
 * Represents a scheduled task.
 */
export class ScheduledTask {
  private readonly definition: TaskDefinition
  private lastRun: Date | null = null
  private isRunning = false

  constructor(definition: TaskDefinition) {
    this.definition = definition
  }

  /**
   * Get the task name.
   */
  getName(): string {
    return this.definition.name ?? 'anonymous'
  }

  /**
   * Get the cron expression.
   */
  getExpression(): string {
    return this.definition.expression
  }

  /**
   * Get the timezone.
   */
  getTimezone(): string | undefined {
    return this.definition.timezone
  }

  /**
   * Check if the task is due.
   */
  isDue(date: Date = new Date()): boolean {
    if (this.definition.timezone) {
      return isDueInTimezone(this.definition.expression, this.definition.timezone, date)
    }
    return isDue(this.definition.expression, date)
  }

  /**
   * Check if the task should run based on conditions.
   * Note: Overlap checking is handled separately in run() to prevent race conditions.
   */
  async shouldRun(): Promise<boolean> {
    // Check when condition
    if (this.definition.when) {
      const result = await this.definition.when()
      if (!result) {
        return false
      }
    }

    // Check skip condition
    if (this.definition.skip) {
      const result = await this.definition.skip()
      if (result) {
        return false
      }
    }

    return true
  }

  /**
   * Run the task.
   */
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
      // Before callback
      if (this.definition.before) {
        await this.definition.before()
      }

      // Run the task
      await this.definition.callback()
      this.lastRun = new Date()

      // Success callback
      if (this.definition.onSuccess) {
        await this.definition.onSuccess()
      }
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err))

      // Failure callback
      if (this.definition.onFailure) {
        await this.definition.onFailure(error)
      }
    } finally {
      this.isRunning = false

      // After callback (always runs)
      if (this.definition.after) {
        await this.definition.after()
      }
    }

    if (error) {
      throw error
    }
  }

  /**
   * Get the last run time.
   */
  getLastRun(): Date | null {
    return this.lastRun
  }

  /**
   * Check if the task is currently running.
   */
  isCurrentlyRunning(): boolean {
    return this.isRunning
  }

  /**
   * Get the task definition.
   */
  getDefinition(): TaskDefinition {
    return { ...this.definition }
  }
}
