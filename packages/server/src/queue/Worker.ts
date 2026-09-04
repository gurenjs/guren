import type { QueueDriver, QueuedJob, WorkerOptions } from './types'
import { getJob, type JobClass } from './Job'

/**
 * Worker events.
 */
export interface WorkerEvents {
  /**
   * Emitted when a job is processed successfully.
   */
  jobProcessed?: (job: QueuedJob) => void

  /**
   * Emitted when a job fails (but may retry).
   */
  jobFailed?: (job: QueuedJob, error: Error, willRetry: boolean) => void

  /**
   * Emitted when the worker starts.
   */
  workerStarted?: () => void

  /**
   * Emitted when the worker stops.
   */
  workerStopped?: () => void
}

/**
 * Queue worker that processes jobs.
 *
 * @example
 * ```ts
 * import { Worker, MemoryDriver, setQueueDriver } from '@guren/server/queue'
 *
 * const driver = new MemoryDriver()
 * setQueueDriver(driver)
 *
 * const worker = new Worker(driver, {
 *   queues: ['default', 'emails'],
 *   sleep: 1000,
 * })
 *
 * // Start processing
 * await worker.start()
 *
 * // Stop gracefully
 * await worker.stop()
 * ```
 */
export class Worker {
  private running = false
  private shouldStop = false
  private processedJobs = 0
  private readonly queues: string[]
  private readonly sleep: number
  private readonly maxJobs: number
  private readonly timeout: number
  private readonly stopWhenEmpty: boolean
  private currentJob: QueuedJob | null = null

  constructor(
    private readonly driver: QueueDriver,
    private readonly options: WorkerOptions = {},
    private readonly events: WorkerEvents = {}
  ) {
    this.queues = options.queues ?? ['default']
    this.sleep = options.sleep ?? 1000
    this.maxJobs = options.maxJobs ?? 0
    this.timeout = options.timeout ?? 60000
    this.stopWhenEmpty = options.stopWhenEmpty ?? false
  }

  /**
   * Start the worker.
   */
  async start(): Promise<void> {
    if (this.running) {
      return
    }

    this.running = true
    this.shouldStop = false
    this.processedJobs = 0

    this.events.workerStarted?.()

    while (!this.shouldStop) {
      // Check max jobs limit
      if (this.maxJobs > 0 && this.processedJobs >= this.maxJobs) {
        break
      }

      const job = await this.getNextJob()

      if (job) {
        await this.processJob(job)
        this.processedJobs++
      } else {
        // No jobs available
        if (this.stopWhenEmpty) {
          break
        }
        await this.sleepMs(this.sleep)
      }
    }

    this.running = false
    this.events.workerStopped?.()
  }

  /**
   * Stop the worker gracefully.
   */
  async stop(): Promise<void> {
    this.shouldStop = true

    // Wait for current job to finish (with timeout)
    const startWait = Date.now()
    while (this.running && this.currentJob && Date.now() - startWait < this.timeout) {
      await this.sleepMs(100)
    }
  }

  /**
   * Check if the worker is running.
   */
  isRunning(): boolean {
    return this.running
  }

  /**
   * Get the number of processed jobs.
   */
  getProcessedJobsCount(): number {
    return this.processedJobs
  }

  /**
   * Get the next available job from the queues.
   */
  private async getNextJob(): Promise<QueuedJob | null> {
    for (const queue of this.queues) {
      const job = await this.driver.pop(queue)
      if (job) {
        return job
      }
    }
    return null
  }

  /**
   * Process a single job.
   */
  private async processJob(job: QueuedJob): Promise<void> {
    this.currentJob = job
    job.attempts++

    const JobClass = getJob(job.name)
    if (!JobClass) {
      console.error(`Job class not found: ${job.name}`)
      await this.driver.fail(job, new Error(`Job class not found: ${job.name}`))
      this.currentJob = null
      return
    }

    try {
      // Create job instance
      const instance = new JobClass()

      // Execute with timeout
      await this.executeWithTimeout(
        async () => instance.handle(job.payload),
        this.timeout
      )

      // Job completed successfully
      await this.driver.delete(job.id)
      this.events.jobProcessed?.(job)
    } catch (error) {
      await this.handleFailedJob(job, error as Error, JobClass)
    } finally {
      this.currentJob = null
    }
  }

  /**
   * Handle a failed job.
   */
  private async handleFailedJob(
    job: QueuedJob,
    error: Error,
    JobClass: JobClass
  ): Promise<void> {
    const willRetry = job.attempts < job.maxAttempts

    if (willRetry) {
      // The driver owns the wait: a queue-backed driver makes the job available
      // after `delay`, while SyncDriver re-runs it before release() resolves.
      const delay = JobClass.calculateRetryDelay(job.attempts)
      job.lastError = error.message
      await this.driver.release(job, delay)
    } else {
      // Max attempts reached, move to failed
      await this.driver.fail(job, error)

      // Call the failed handler if defined
      try {
        const instance = new JobClass()
        if (instance.failed) {
          await instance.failed(job.payload, error)
        }
      } catch (failedError) {
        console.error(`Error in job.failed() handler:`, failedError)
      }
    }

    // Structured log so failures are visible even without custom event listeners
    console.error(JSON.stringify({
      level: 'error',
      msg: `Job failed: ${job.name}`,
      job: job.name,
      queue: job.queue ?? 'default',
      attempt: job.attempts,
      maxAttempts: job.maxAttempts,
      willRetry,
      error: error.message,
    }))

    this.events.jobFailed?.(job, error, willRetry)
  }

  /**
   * Execute a function with a timeout.
   */
  private async executeWithTimeout<T>(
    fn: () => Promise<T>,
    timeoutMs: number
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Job timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      fn()
        .then((result) => {
          clearTimeout(timer)
          resolve(result)
        })
        .catch((error) => {
          clearTimeout(timer)
          reject(error)
        })
    })
  }

  /**
   * Sleep for a given number of milliseconds.
   */
  private sleepMs(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

/**
 * Process a single job (for testing or one-off execution).
 */
export async function processJob(
  driver: QueueDriver,
  queue: string = 'default'
): Promise<boolean> {
  const worker = new Worker(driver, { queues: [queue], maxJobs: 1, stopWhenEmpty: true })
  await worker.start()
  return worker.getProcessedJobsCount() > 0
}
