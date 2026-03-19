/**
 * Serialized job data stored in the queue.
 */
export interface QueuedJob<T = unknown> {
  /**
   * Unique job identifier.
   */
  id: string

  /**
   * Job class name.
   */
  name: string

  /**
   * Job payload data.
   */
  payload: T

  /**
   * Queue name this job belongs to.
   */
  queue: string

  /**
   * Number of times this job has been attempted.
   */
  attempts: number

  /**
   * Maximum number of attempts before failing permanently.
   */
  maxAttempts: number

  /**
   * When the job becomes available for processing.
   */
  availableAt: Date

  /**
   * When the job was created.
   */
  createdAt: Date

  /**
   * When the job was reserved by a worker (null if not reserved).
   */
  reservedAt: Date | null

  /**
   * Last error message if the job failed.
   */
  lastError?: string
}

/**
 * Failed job record.
 */
export interface FailedJob<T = unknown> extends QueuedJob<T> {
  /**
   * When the job failed.
   */
  failedAt: Date

  /**
   * Error that caused the failure.
   */
  error: string

  /**
   * Stack trace of the error.
   */
  stack?: string
}

/**
 * Queue driver interface.
 * Implement this to create a custom queue backend.
 */
export interface QueueDriver {
  /**
   * Push a job onto the queue.
   */
  push(job: QueuedJob): Promise<void>

  /**
   * Pop the next available job from the queue.
   * Returns null if no jobs are available.
   */
  pop(queue: string): Promise<QueuedJob | null>

  /**
   * Release a job back onto the queue (for retry).
   * @param job - The job to release
   * @param delayMs - Delay before the job becomes available again
   */
  release(job: QueuedJob, delayMs?: number): Promise<void>

  /**
   * Delete a job from the queue.
   */
  delete(jobId: string): Promise<void>

  /**
   * Mark a job as failed and move to failed jobs.
   */
  fail(job: QueuedJob, error: Error): Promise<void>

  /**
   * Get the number of jobs in a queue.
   */
  size(queue: string): Promise<number>

  /**
   * Get failed jobs.
   */
  getFailedJobs(queue?: string): Promise<FailedJob[]>

  /**
   * Retry a failed job.
   */
  retryFailedJob(jobId: string): Promise<void>

  /**
   * Delete a failed job.
   */
  deleteFailedJob(jobId: string): Promise<void>

  /**
   * Clear all jobs (for testing).
   */
  clear(): Promise<void>
}

/**
 * Options for creating a job.
 */
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

/**
 * Worker options.
 */
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

/**
 * Job handler function type.
 */
export type JobHandler<T = unknown> = (payload: T) => void | Promise<void>

/**
 * Job failure handler function type.
 */
export type JobFailureHandler<T = unknown> = (payload: T, error: Error) => void | Promise<void>
