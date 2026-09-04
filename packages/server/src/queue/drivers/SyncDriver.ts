import type { QueueDriver, QueuedJob, FailedJob } from '../types'
import { getJob } from '../Job'

/**
 * Runs jobs inline in the dispatching process, no worker required: the
 * development default. Dispatch semantics match a real queue but failures
 * surface immediately, and retry backoff is not honored because nothing waits
 * in a sync queue (`release()` re-runs the job at once whatever `delayMs`).
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
   * Re-run the job now, ignoring `delayMs`: honoring a backoff would block the
   * releasing caller for the full delay, and a detached timer would move the
   * failure off the call that surfaces it. A failure rethrows, as `push()` does.
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
