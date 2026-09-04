import type { QueueDriver, QueuedJob, FailedJob } from '../types'
import { getJob } from '../Job'

/**
 * Synchronous queue driver: jobs execute immediately in the dispatching
 * process, no worker required. This is the development default — dispatch
 * semantics stay identical to a real queue, but failures surface right away
 * and nothing needs a second process.
 *
 * Because nothing waits in a sync queue, retry backoff is not honored:
 * `release()` re-runs the job immediately whatever `delayMs` it is handed.
 *
 * @example
 * ```ts
 * const queue = createQueueManager({
 *   default: 'sync',
 *   drivers: { sync: () => new SyncDriver() },
 * })
 * ```
 */
export class SyncDriver implements QueueDriver {
  private failedJobs: Map<string, FailedJob> = new Map()

  async push(job: QueuedJob): Promise<void> {
    const JobClass = getJob(job.name)
    if (!JobClass) {
      throw new Error(
        `SyncDriver: job class "${job.name}" is not registered. Call registerJob() with the class whose jobName (or class name) is "${job.name}".`,
      )
    }

    job.attempts += 1
    try {
      const instance = new JobClass()
      await instance.handle(job.payload)
    } catch (error) {
      await this.fail(job, error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  }

  async pop(): Promise<QueuedJob | null> {
    // Jobs never wait in a sync queue.
    return null
  }

  /**
   * Re-run the job now, ignoring `delayMs`.
   *
   * There is no queue to wait in: the job runs inline in the process that
   * released it, so honoring a backoff (2s, 4s, 8s under the default
   * exponential strategy) would block that caller for the full delay, and a
   * detached timer would move the failure off the call that surfaces it. Sync
   * mode therefore retries immediately; a failure fails the job and rethrows,
   * exactly as `push()` does.
   */
  async release(job: QueuedJob, _delayMs?: number): Promise<void> {
    await this.push(job)
  }

  async delete(): Promise<void> {}

  async fail(job: QueuedJob, error: Error): Promise<void> {
    this.failedJobs.set(job.id, {
      ...job,
      failedAt: new Date(),
      error: error.message,
      stack: error.stack,
    })
  }

  async size(): Promise<number> {
    return 0
  }

  async getFailedJobs(queue?: string): Promise<FailedJob[]> {
    const failed = [...this.failedJobs.values()]
    return queue ? failed.filter((job) => job.queue === queue) : failed
  }

  async retryFailedJob(jobId: string): Promise<void> {
    const failed = this.failedJobs.get(jobId)
    if (!failed) {
      throw new Error(`SyncDriver: failed job "${jobId}" not found.`)
    }
    this.failedJobs.delete(jobId)
    const { failedAt: _failedAt, error: _error, stack: _stack, ...job } = failed
    await this.push({ ...job, reservedAt: null })
  }

  async deleteFailedJob(jobId: string): Promise<void> {
    this.failedJobs.delete(jobId)
  }

  async clear(): Promise<void> {
    this.failedJobs.clear()
  }
}
