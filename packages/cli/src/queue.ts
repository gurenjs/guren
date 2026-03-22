import { pathToFileURL } from 'node:url'
import { consola } from 'consola'
import {
  Worker,
  getQueueDriver,
  type QueueDriver,
  type WorkerEvents,
} from './queue-deps'
import { bootstrapApplication, resolveMainEntry } from './runtime'

/**
 * Options for running the queue worker.
 */
export interface QueueWorkOptions {
  /**
   * Queues to process (comma-separated).
   * @default 'default'
   */
  queue?: string

  /**
   * Process only one job and exit.
   */
  once?: boolean

  /**
   * Sleep time between job polling (ms).
   * @default 1000
   */
  sleep?: number

  /**
   * Maximum number of jobs to process.
   * @default 0 (unlimited)
   */
  maxJobs?: number

  /**
   * Job timeout in seconds.
   * @default 60
   */
  timeout?: number
}

/**
 * Start the queue worker.
 */
export async function runQueueWorker(options: QueueWorkOptions = {}): Promise<void> {
  // Bootstrap the application to get the queue driver
  const driver = await getConfiguredDriver()

  const queues = (options.queue ?? 'default').split(',').map((q) => q.trim())
  const sleep = options.sleep ?? 1000
  const maxJobs = options.once ? 1 : (options.maxJobs ?? 0)
  const timeout = (options.timeout ?? 60) * 1000
  const stopWhenEmpty = options.once ?? false

  const events: WorkerEvents = {
    workerStarted: () => {
      consola.info(`Queue worker started. Processing: ${queues.join(', ')}`)
    },
    workerStopped: () => {
      consola.info('Queue worker stopped.')
    },
    jobProcessed: (job) => {
      consola.success(`[${job.queue}] Job ${job.name} (${job.id}) processed.`)
    },
    jobFailed: (job, error, willRetry) => {
      if (willRetry) {
        consola.warn(
          `[${job.queue}] Job ${job.name} (${job.id}) failed (attempt ${job.attempts}/${job.maxAttempts}): ${error.message}`
        )
      } else {
        consola.error(
          `[${job.queue}] Job ${job.name} (${job.id}) failed permanently: ${error.message}`
        )
      }
    },
  }

  const worker = new Worker(driver, { queues, sleep, maxJobs, timeout, stopWhenEmpty }, events)

  // Handle graceful shutdown
  const shutdown = async () => {
    consola.info('Shutting down worker...')
    await worker.stop()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  await worker.start()
}

/**
 * List failed jobs.
 */
export async function listFailedJobs(queue?: string): Promise<void> {
  const driver = await getConfiguredDriver()
  const failedJobs = await driver.getFailedJobs(queue)

  if (failedJobs.length === 0) {
    consola.info('No failed jobs.')
    return
  }

  consola.info(`Found ${failedJobs.length} failed job(s):\n`)

  for (const job of failedJobs) {
    console.log(`  ID: ${job.id}`)
    console.log(`  Name: ${job.name}`)
    console.log(`  Queue: ${job.queue}`)
    console.log(`  Error: ${job.error}`)
    console.log(`  Failed At: ${job.failedAt.toISOString()}`)
    console.log(`  Attempts: ${job.attempts}/${job.maxAttempts}`)
    console.log('')
  }
}

/**
 * Retry a failed job.
 */
export async function retryFailedJob(jobId: string): Promise<void> {
  const driver = await getConfiguredDriver()

  try {
    await driver.retryFailedJob(jobId)
    consola.success(`Job ${jobId} has been pushed back to the queue.`)
  } catch (error) {
    consola.error(`Failed to retry job: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

async function processFailedJobs(
  action: 'retry' | 'flush',
  queue?: string,
): Promise<void> {
  const driver = await getConfiguredDriver()
  const failedJobs = await driver.getFailedJobs(queue)

  if (failedJobs.length === 0) {
    consola.info(`No failed jobs to ${action}.`)
    return
  }

  let count = 0
  for (const job of failedJobs) {
    try {
      await (action === 'retry' ? driver.retryFailedJob(job.id) : driver.deleteFailedJob(job.id))
      count++
    } catch (error) {
      consola.warn(`Failed to ${action} job ${job.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  consola.success(`${action === 'retry' ? 'Retried' : 'Flushed'} ${count} job(s).`)
}

/**
 * Retry all failed jobs.
 */
export async function retryAllFailedJobs(queue?: string): Promise<void> {
  await processFailedJobs('retry', queue)
}

/**
 * Flush (delete) all failed jobs.
 */
export async function flushFailedJobs(queue?: string): Promise<void> {
  await processFailedJobs('flush', queue)
}

/**
 * Bootstrap the application and get the configured queue driver.
 */
async function getConfiguredDriver(): Promise<QueueDriver> {
  let entry: string
  try {
    entry = await resolveMainEntry()
  } catch (error) {
    consola.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }

  try {
    const mod = await import(pathToFileURL(entry).href)
    await bootstrapApplication(mod)
  } catch (error) {
    consola.error(`Failed to bootstrap application:`, error)
    process.exit(1)
  }

  const driver = getQueueDriver()
  if (!driver) {
    consola.error('Queue driver not configured. Make sure your application boots a queue manager and activates a driver.')
    process.exit(1)
  }

  return driver
}
