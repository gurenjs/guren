export type TaskCallback = () => void | Promise<void>

export interface TaskDefinition {
  name?: string

  expression: string

  timezone?: string

  callback: TaskCallback

  withoutOverlapping?: boolean

  /**
   * Milliseconds after which a still-running invocation stops blocking the
   * next one under `withoutOverlapping`, so a hung run does not block forever.
   */
  overlapExpiresAt?: number

  /** Runs only on the server that wins the tick's `SchedulerLock`; needs a name to key it on. */
  onOneServer?: boolean

  when?: () => boolean | Promise<boolean>

  skip?: () => boolean | Promise<boolean>

  before?: () => void | Promise<void>

  after?: () => void | Promise<void>

  onSuccess?: () => void | Promise<void>

  onFailure?: (error: Error) => void | Promise<void>
}

/**
 * Cross-server mutex for `runOnOneServer()` tasks. `acquire` must be atomic
 * (set-if-absent with expiry): two servers asking for the same key in the same
 * tick must get one `true` between them.
 */
export interface SchedulerLock {
  acquire(key: string, ttlSeconds: number): Promise<boolean>
  release(key: string): Promise<void>
}

export interface SchedulerOptions {
  /** @default 'UTC' */
  timezone?: string

  /** Milliseconds. @default 60000 */
  checkInterval?: number

  logger?: (message: string) => void

  /**
   * Backs `runOnOneServer()`. Defaults to a `MemorySchedulerLock`, which holds
   * for one process only; a multi-server deploy needs a shared one
   * (`RedisSchedulerLock`) or the task runs on every server.
   */
  lock?: SchedulerLock

  /**
   * Prefixes every `runOnOneServer()` key. Two apps sharing one lock store must
   * set distinct prefixes, or a task name they have in common claims one tick
   * between them. @default 'schedule:'
   */
  lockPrefix?: string
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
