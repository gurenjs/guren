export type TaskCallback = () => void | Promise<void>

export interface TaskDefinition {
  name?: string

  expression: string

  timezone?: string

  callback: TaskCallback

  withoutOverlapping?: boolean

  /** Milliseconds. */
  overlapExpiresAt?: number

  /** Requires a distributed lock. */
  onOneServer?: boolean

  when?: () => boolean | Promise<boolean>

  skip?: () => boolean | Promise<boolean>

  before?: () => void | Promise<void>

  after?: () => void | Promise<void>

  onSuccess?: () => void | Promise<void>

  onFailure?: (error: Error) => void | Promise<void>
}

export interface SchedulerOptions {
  /** @default 'UTC' */
  timezone?: string

  /** Milliseconds. @default 60000 */
  checkInterval?: number

  logger?: (message: string) => void
}

export interface ParsedCron {
  minute: number[]
  hour: number[]
  dayOfMonth: number[]
  month: number[]
  dayOfWeek: number[]
}

export interface JobClass<T = unknown> {
  dispatch(payload: T): Promise<void>
  dispatchAfter?(delayMs: number, payload: T): Promise<void>
}
