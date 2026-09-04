/** Serialized job data stored in the queue. */
export interface QueuedJob<T = unknown> {
  id: string

  /** The job class name; the registry resolves it back to the class. */
  name: string

  payload: T

  queue: string

  attempts: number

  maxAttempts: number

  availableAt: Date

  createdAt: Date

  reservedAt: Date | null

  lastError?: string
}

/** Failed job record. */
export interface FailedJob<T = unknown> extends QueuedJob<T> {
  failedAt: Date

  error: string

  stack?: string
}

/** Implement to add a queue backend. */
export interface QueueDriver {
  push(job: QueuedJob): Promise<void>

  pop(queue: string): Promise<QueuedJob | null>

  /**
   * Release a job for retry. The driver owns the delay: one with nothing to wait
   * in (`SyncDriver`) may run the job again before this resolves.
   */
  release(job: QueuedJob, delayMs?: number): Promise<void>

  delete(jobId: string): Promise<void>

  fail(job: QueuedJob, error: Error): Promise<void>

  size(queue: string): Promise<number>

  getFailedJobs(queue?: string): Promise<FailedJob[]>

  retryFailedJob(jobId: string): Promise<void>

  deleteFailedJob(jobId: string): Promise<void>

  clear(): Promise<void>
}

/** Options for creating a job. */
export interface JobOptions {
  /**
   * Queue to dispatch the job to.
   * @default 'default'
   */
  queue?: string

  /**
   * Delay in milliseconds before the job is available.
   * @default 0
   */
  delay?: number

  /**
   * Maximum number of attempts.
   * @default 3
   */
  maxAttempts?: number
}

/** Worker options. */
export interface WorkerOptions {
  /**
   * Queues to process (in priority order).
   * @default ['default']
   */
  queues?: string[]

  /**
   * Sleep time in milliseconds when no jobs are available.
   * @default 1000
   */
  sleep?: number

  /**
   * Maximum number of jobs to process before stopping.
   * Set to 0 for unlimited.
   * @default 0
   */
  maxJobs?: number

  /**
   * Timeout for each job in milliseconds.
   * @default 60000
   */
  timeout?: number

  /**
   * Stop the worker when no jobs are available.
   * Useful for one-shot processing or testing.
   * @default false
   */
  stopWhenEmpty?: boolean
}

/** Job handler function type. */
export type JobHandler<T = unknown> = (payload: T) => void | Promise<void>

/** Job failure handler function type. */
export type JobFailureHandler<T = unknown> = (payload: T, error: Error) => void | Promise<void>
