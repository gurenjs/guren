import type { QueueDriver, QueuedJob, FailedJob } from '../types'

/**
 * In-memory queue driver for development and testing.
 *
 * @example
 * ```ts
 * import { MemoryDriver, setQueueDriver } from '@guren/server/queue'
 *
 * const driver = new MemoryDriver()
 * setQueueDriver(driver)
 * ```
 */
export class MemoryDriver implements QueueDriver {
  private jobs: Map<string, QueuedJob> = new Map()
  private failedJobs: Map<string, FailedJob> = new Map()

  /**
   * Push a job onto the queue.
   */
  async push(job: QueuedJob): Promise<void> {
    this.jobs.set(job.id, { ...job })
  }

  /**
   * Pop the next available job from the queue.
   */
  async pop(queue: string): Promise<QueuedJob | null> {
    const now = new Date()

    // Find the first available job for this queue
    for (const [id, job] of this.jobs) {
      if (
        job.queue === queue &&
        job.availableAt <= now &&
        job.reservedAt === null
      ) {
        // Reserve the job
        job.reservedAt = now
        return { ...job }
      }
    }

    return null
  }

  /**
   * Release a job back onto the queue.
   */
  async release(job: QueuedJob, delayMs: number = 0): Promise<void> {
    const existing = this.jobs.get(job.id)
    if (existing) {
      existing.reservedAt = null
      existing.availableAt = new Date(Date.now() + delayMs)
      existing.attempts = job.attempts
      if (job.lastError) {
        existing.lastError = job.lastError
      }
    }
  }

  /**
   * Delete a job from the queue.
   */
  async delete(jobId: string): Promise<void> {
    this.jobs.delete(jobId)
  }

  /**
   * Mark a job as failed.
   */
  async fail(job: QueuedJob, error: Error): Promise<void> {
    const failedJob: FailedJob = {
      ...job,
      failedAt: new Date(),
      error: error.message,
      stack: error.stack,
    }
    this.failedJobs.set(job.id, failedJob)
    this.jobs.delete(job.id)
  }

  /**
   * Get the number of jobs in a queue.
   */
  async size(queue: string): Promise<number> {
    let count = 0
    for (const job of this.jobs.values()) {
      if (job.queue === queue && job.reservedAt === null) {
        count++
      }
    }
    return count
  }

  /**
   * Get failed jobs.
   */
  async getFailedJobs(queue?: string): Promise<FailedJob[]> {
    const jobs: FailedJob[] = []
    for (const job of this.failedJobs.values()) {
      if (!queue || job.queue === queue) {
        jobs.push({ ...job })
      }
    }
    return jobs.sort((a, b) => b.failedAt.getTime() - a.failedAt.getTime())
  }

  /**
   * Retry a failed job.
   */
  async retryFailedJob(jobId: string): Promise<void> {
    const failedJob = this.failedJobs.get(jobId)
    if (!failedJob) {
      throw new Error(`Failed job not found: ${jobId}`)
    }

    // Move back to pending
    const job: QueuedJob = {
      id: failedJob.id,
      name: failedJob.name,
      payload: failedJob.payload,
      queue: failedJob.queue,
      attempts: 0,
      maxAttempts: failedJob.maxAttempts,
      availableAt: new Date(),
      createdAt: new Date(),
      reservedAt: null,
    }

    this.jobs.set(job.id, job)
    this.failedJobs.delete(jobId)
  }

  /**
   * Delete a failed job.
   */
  async deleteFailedJob(jobId: string): Promise<void> {
    this.failedJobs.delete(jobId)
  }

  /**
   * Clear all jobs (for testing).
   */
  async clear(): Promise<void> {
    this.jobs.clear()
    this.failedJobs.clear()
  }

  /**
   * Get all pending jobs (for testing/debugging).
   */
  getPendingJobs(queue?: string): QueuedJob[] {
    const jobs: QueuedJob[] = []
    for (const job of this.jobs.values()) {
      if (!queue || job.queue === queue) {
        jobs.push({ ...job })
      }
    }
    return jobs
  }
}
