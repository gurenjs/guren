/**
 * Information about a failed queue job.
 */
export interface FailedJobInfo {
  jobName: string
  queue: string
  attempt: number
  maxAttempts: number
  willRetry: boolean
  error: Error
  failedAt: Date
}

/**
 * Handler function invoked when a job fails.
 */
export type FailedJobHandler = (info: FailedJobInfo) => void | Promise<void>

/**
 * Default handler that writes structured JSON to stderr.
 */
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

/**
 * Configurable reporter for failed queue jobs.
 *
 * Registered by default in QueueServiceProvider to log failures.
 * Can be extended with custom handlers (e.g., Sentry, Slack notifications).
 *
 * @example
 * ```ts
 * const reporter = new FailedJobReporter()
 *
 * // Add a custom handler alongside the default logger
 * reporter.onFailure(async (info) => {
 *   await sendToSentry(info.error)
 * })
 * ```
 */
export class FailedJobReporter {
  private handlers: FailedJobHandler[] = []

  constructor() {
    // Default handler: structured log output
    this.handlers.push(defaultLogHandler)
  }

  /** Add a custom handler for failed jobs. */
  onFailure(handler: FailedJobHandler): this {
    this.handlers.push(handler)
    return this
  }

  /** Report a job failure to all registered handlers. */
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
