import { pathToFileURL } from 'node:url'
import { consola } from 'consola'
import {
  Worker,
  getQueueDriver,
  type ContainerLike,
  type QueueDriver,
  type WorkerEvents,
} from './queue-deps'
import { bootstrapApplication, resolveMainEntry, type MaybeApplication } from './runtime'

export interface QueueWorkOptions {
  /** Queues to process (comma-separated). @default 'default' */
  queue?: string

  /** Process only one job and exit. */
  once?: boolean

  /** Sleep time between job polling (ms). @default 1000 */
  sleep?: number

  /** Maximum number of jobs to process. @default 0 (unlimited) */
  maxJobs?: number

  /** Job timeout in seconds. @default 60 */
  timeout?: number
}

export async function runQueueWorker(options: QueueWorkOptions = {}): Promise<void> {
  const { driver, container } = await getConfiguredQueue()

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

  const worker = new Worker(driver, { queues, sleep, maxJobs, timeout, stopWhenEmpty, container }, events)

  const shutdown = async () => {
    consola.info('Shutting down worker...')
    await worker.stop()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  await worker.start()
}

export async function listFailedJobs(queue?: string, options: { json?: boolean } = {}): Promise<void> {
  const driver = await getConfiguredDriver()
  const failedJobs = await driver.getFailedJobs(queue)

  if (options.json) {
    console.log(JSON.stringify(failedJobs.map((job) => ({
      id: job.id,
      name: job.name,
      queue: job.queue,
      error: job.error,
      failedAt: job.failedAt.toISOString(),
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
    })), null, 2))
    return
  }

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

export async function retryAllFailedJobs(queue?: string): Promise<void> {
  await processFailedJobs('retry', queue)
}

export async function flushFailedJobs(queue?: string): Promise<void> {
  await processFailedJobs('flush', queue)
}

/** The `queue` manager surface the worker needs from the app's container. */
interface BoundQueueManager {
  driver: () => QueueDriver
  hasDriver: (name: string) => boolean
  getDefaultDriverName: () => string
}

/**
 * Boots the app and resolves its queue driver: the `queue` manager its own
 * container binds (RFC 0023 §3), else the driver `getQueueDriver()` reads
 * from the default application. The container rides along so the worker can
 * hand it to each job.
 */
async function getConfiguredQueue(): Promise<{ driver: QueueDriver; container: ContainerLike | undefined }> {
  let entry: string
  try {
    entry = await resolveMainEntry()
  } catch (error) {
    consola.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }

  let app: MaybeApplication
  try {
    const mod = await import(pathToFileURL(entry).href)
    app = await bootstrapApplication(mod)
  } catch (error) {
    consola.error(`Failed to bootstrap application:`, error)
    process.exit(1)
  }

  const container = appContainer(app)
  const manager = container?.has?.('queue') ? (container.make('queue') as BoundQueueManager) : undefined
  const driver = manager?.hasDriver(manager.getDefaultDriverName()) ? manager.driver() : getQueueDriver()
  if (!driver) {
    consola.error('Queue driver not configured. Make sure your application boots a queue manager and activates a driver.')
    process.exit(1)
  }

  return { driver, container }
}

/** The app's container as a `ContainerLike`, or undefined for an app whose container is some other object. */
function appContainer(app: MaybeApplication): ContainerLike | undefined {
  const container = app.container
  if (!container || typeof container.make !== 'function') return undefined
  const make = container.make
  return { make: (key) => make(key), has: container.has }
}

async function getConfiguredDriver(): Promise<QueueDriver> {
  return (await getConfiguredQueue()).driver
}
