import type { QueueDriver, QueuedJob, WorkerOptions } from './types'
import { getJob, type Job, type JobClass } from './Job'

class ReservationLostError extends Error {}

export interface WorkerEvents {
  jobProcessed?: (job: QueuedJob) => void

  /** Emitted on a failure that may still retry. */
  jobFailed?: (job: QueuedJob, error: Error, willRetry: boolean) => void

  workerStarted?: () => void

  workerStopped?: () => void
}

/**
 * Pulls jobs off a driver's queues in priority order and runs each under a
 * timeout, retrying through `driver.release()`.
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

  async start(): Promise<void> {
    if (this.running) {
      return
    }

    this.running = true
    this.shouldStop = false
    this.processedJobs = 0

    try {
      this.events.workerStarted?.()
      while (!this.shouldStop) {
        if (this.maxJobs > 0 && this.processedJobs >= this.maxJobs) break
        const job = await this.getNextJob()
        if (job) {
          await this.processJob(job)
          this.processedJobs++
        } else {
          if (this.stopWhenEmpty) break
          await this.sleepMs(this.sleep)
        }
      }
    } finally {
      this.currentJob = null
      this.running = false
      this.events.workerStopped?.()
    }
  }

  async stop(): Promise<void> {
    this.shouldStop = true

    const startWait = Date.now()
    while (this.running && this.currentJob && Date.now() - startWait < this.timeout) {
      await this.sleepMs(100)
    }
  }

  isRunning(): boolean {
    return this.running
  }

  getProcessedJobsCount(): number {
    return this.processedJobs
  }

  private async getNextJob(): Promise<QueuedJob | null> {
    for (const queue of this.queues) {
      const job = await this.driver.pop(queue)
      if (job) {
        return job
      }
    }
    return null
  }

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
      await this.runHandler(this.instantiate(JobClass), job)
      await this.driver.delete(job.id, job.reservationToken)
      this.events.jobProcessed?.(job)
    } catch (error) {
      if (error instanceof ReservationLostError) {
        // Another worker owns the job now: acknowledging or releasing it would race
        // that worker, so the driver's visibility timeout is left to settle it.
        console.error(JSON.stringify({ level: 'error', msg: `Job reservation lost: ${job.name}`, job: job.name, queue: job.queue, attempt: job.attempts }))
        this.events.jobFailed?.(job, error, true)
        return
      }
      await this.handleFailedJob(job, error instanceof Error ? error : new Error(String(error)), JobClass)
    } finally {
      this.currentJob = null
    }
  }

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
      await this.driver.fail(job, error)

      try {
        const instance = this.instantiate(JobClass)
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

  private instantiate(JobClass: JobClass): Job {
    const instance = new JobClass()
    if (this.options.container) {
      instance.setContainer(this.options.container)
    }
    return instance
  }

  /**
   * Runs `handle()` under the timeout while renewing the driver's reservation. A
   * timeout requests cancellation through the job's signal and then waits for the
   * handler to settle, so a retry never runs beside its predecessor.
   */
  private async runHandler(instance: Job, job: QueuedJob): Promise<void> {
    const cancellation = new AbortController()
    const timeout = setTimeout(() => {
      cancellation.abort(new Error(`Job timed out after ${this.timeout}ms`))
    }, this.timeout)
    // One renewal in flight at a time: the next is armed only after the previous
    // settles, so a slow driver cannot pile up EXTEND calls.
    const interval = this.driver.extendReservation ? this.driver.heartbeatInterval : undefined
    let heartbeat: ReturnType<typeof setTimeout> | undefined
    let renewal: Promise<void> | undefined
    let reservationError: ReservationLostError | undefined
    let settled = false
    const renew = (): void => {
      renewal = this.driver.extendReservation!(job).then((owned) => {
        if (owned) return
        reservationError = new ReservationLostError('Job reservation now belongs to another worker')
        cancellation.abort(reservationError)
      }, () => {
        // A rejected renewal is a driver error, not a lost lease: the next heartbeat
        // retries, and a lease that did expire is fenced at delete/release anyway.
      }).finally(() => {
        if (!settled && !reservationError && interval !== undefined) heartbeat = setTimeout(renew, interval)
      })
    }
    if (interval !== undefined) heartbeat = setTimeout(renew, interval)

    let failure: { error: unknown } | undefined
    try {
      instance.setExecutionSignal(cancellation.signal)
      await instance.handle(job.payload)
    } catch (error) {
      failure = { error }
    } finally {
      settled = true
      clearTimeout(timeout)
      clearTimeout(heartbeat)
      await renewal
    }
    if (reservationError) throw reservationError
    // A handler that ignored the timeout but settled successfully is acknowledged:
    // retrying a completed job is the duplicate run the timeout exists to prevent.
    if (failure) throw cancellation.signal.aborted ? cancellation.signal.reason : failure.error
  }

  private sleepMs(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

/** Process one job without a running worker, for tests and one-off execution. */
export async function processJob(
  driver: QueueDriver,
  queue: string = 'default',
  options: Pick<WorkerOptions, 'container'> = {},
): Promise<boolean> {
  const worker = new Worker(driver, { ...options, queues: [queue], maxJobs: 1, stopWhenEmpty: true })
  await worker.start()
  return worker.getProcessedJobsCount() > 0
}
