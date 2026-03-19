/**
 * Scheduled task callback.
 */
export type TaskCallback = () => void | Promise<void>

/**
 * Task definition.
 */
export interface TaskDefinition {
  /**
   * Task name.
   */
  name?: string

  /**
   * Cron expression.
   */
  expression: string

  /**
   * Timezone for the schedule.
   */
  timezone?: string

  /**
   * Task callback.
   */
  callback: TaskCallback

  /**
   * Prevent overlapping executions.
   */
  withoutOverlapping?: boolean

  /**
   * Overlap expiration in milliseconds.
   */
  overlapExpiresAt?: number

  /**
   * Only run on one server (requires distributed lock).
   */
  onOneServer?: boolean

  /**
   * Condition callback to determine if task should run.
   */
  when?: () => boolean | Promise<boolean>

  /**
   * Condition callback to skip execution.
   */
  skip?: () => boolean | Promise<boolean>

  /**
   * Before execution callback.
   */
  before?: () => void | Promise<void>

  /**
   * After execution callback.
   */
  after?: () => void | Promise<void>

  /**
   * On success callback.
   */
  onSuccess?: () => void | Promise<void>

  /**
   * On failure callback.
   */
  onFailure?: (error: Error) => void | Promise<void>
}

/**
 * Scheduler options.
 */
export interface SchedulerOptions {
  /**
   * Timezone for all scheduled tasks.
   * @default 'UTC'
   */
  timezone?: string

  /**
   * Check interval in milliseconds.
   * @default 60000 (1 minute)
   */
  checkInterval?: number

  /**
   * Logger function.
   */
  logger?: (message: string) => void
}

/**
 * Parsed cron expression.
 */
export interface ParsedCron {
  minute: number[]
  hour: number[]
  dayOfMonth: number[]
  month: number[]
  dayOfWeek: number[]
}

/**
 * Job class interface for scheduling.
 */
export interface JobClass<T = unknown> {
  dispatch(payload: T): Promise<void>
  dispatchAfter?(delayMs: number, payload: T): Promise<void>
}
