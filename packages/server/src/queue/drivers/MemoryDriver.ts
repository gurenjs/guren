import type { QueueDriver, QueuedJob, FailedJob } from '../types'

/** In-memory queue driver for development and testing. */
export class MemoryDriver implements QueueDriver {
  private jobs: Map<string, QueuedJob> = new Map()
  private failedJobs: Map<string, FailedJob> = new Map()

  async push(job: QueuedJob): Promise<void> {
    this.jobs.set(job.id, { ...job })
  }

  async pop(queue: string): Promise<QueuedJob | null> {
    const now = new Date()

    for (const [_id, job] of this.jobs) {
      if (
        job.queue === queue &&
        job.availableAt <= now &&
        job.reservedAt === null
      ) {
        job.reservedAt = now
        return { ...job }
      }
    }

    return null
  }

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

  async delete(jobId: string): Promise<void> {
    this.jobs.delete(jobId)
  }

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

  async size(queue: string): Promise<number> {
    let count = 0
    for (const job of this.jobs.values()) {
      if (job.queue === queue && job.reservedAt === null) {
        count++
      }
    }
    return count
  }

  async getFailedJobs(queue?: string): Promise<FailedJob[]> {
    const jobs: FailedJob[] = []
    for (const job of this.failedJobs.values()) {
      if (!queue || job.queue === queue) {
        jobs.push({ ...job })
      }
    }
    return jobs.sort((a, b) => b.failedAt.getTime() - a.failedAt.getTime())
  }

  async retryFailedJob(jobId: string): Promise<void> {
    const failedJob = this.failedJobs.get(jobId)
    if (!failedJob) {
      throw new Error(`Failed job not found: ${jobId}`)
    }

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

  async deleteFailedJob(jobId: string): Promise<void> {
    this.failedJobs.delete(jobId)
  }

  /** Testing only. */
  async clear(): Promise<void> {
    this.jobs.clear()
    this.failedJobs.clear()
  }

  /** Testing/debugging only. */
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
