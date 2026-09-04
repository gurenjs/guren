export interface FailedJobInfo {
  jobName: string
  queue: string
  attempt: number
  maxAttempts: number
  willRetry: boolean
  error: Error
  failedAt: Date
}

export type FailedJobHandler = (info: FailedJobInfo) => void | Promise<void>

function defaultLogHandler(info: FailedJobInfo): void {
  console.error(JSON.stringify({
    level: 'error',
    msg: `Job failed: ${info.jobName}`,
    job: info.jobName,
    queue: info.queue,
    attempt: info.attempt,
    maxAttempts: info.maxAttempts,
    willRetry: info.willRetry,
    error: info.error.message,
    failedAt: info.failedAt.toISOString(),
  }))
}

/** Registered by default in QueueServiceProvider; extend with custom handlers. */
export class FailedJobReporter {
  private handlers: FailedJobHandler[] = []

  constructor() {
    this.handlers.push(defaultLogHandler)
  }

  onFailure(handler: FailedJobHandler): this {
    this.handlers.push(handler)
    return this
  }

  async report(info: FailedJobInfo): Promise<void> {
    for (const handler of this.handlers) {
      try {
        await handler(info)
      } catch {
        // Don't let reporter errors break the queue
      }
    }
  }
}
