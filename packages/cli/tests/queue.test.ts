import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTempWorkspace } from './helpers'

let workerOptions: Record<string, unknown> | undefined
let fakeDriver: {
  getFailedJobs: ReturnType<typeof mock>
  retryFailedJob: ReturnType<typeof mock>
  deleteFailedJob: ReturnType<typeof mock>
}

await mock.module('../src/queue-deps', () => ({
  Worker: class {
    options: Record<string, unknown>
    events: Record<string, (...args: any[]) => void>

    constructor(_driver: unknown, options: Record<string, unknown>, events: Record<string, (...args: any[]) => void>) {
      this.options = options
      this.events = events
      workerOptions = options
    }

    async start() {
      this.events.workerStarted?.()
    }

    async stop() {
      this.events.workerStopped?.()
    }
  },
  getQueueDriver: () => fakeDriver,
}))

const {
  runQueueWorker,
  retryFailedJob,
  retryAllFailedJobs,
  flushFailedJobs,
} = await import('../src/queue')

beforeEach(() => {
  fakeDriver = {
    getFailedJobs: mock(async () => []),
    retryFailedJob: mock(async () => {}),
    deleteFailedJob: mock(async () => {}),
  }
  workerOptions = undefined
})

describe('queue helpers', () => {
  it('configures the worker with derived options', async () => {
    const workspace = await createTempWorkspace('guren-cli-queue-worker-')
    try {
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'src/main.ts'),
        'export default { listen() {} }',
        'utf8',
      )

      await runQueueWorker({ queue: 'default,emails', once: true, sleep: 250, timeout: 5 })

      expect(workerOptions).toMatchObject({
        queues: ['default', 'emails'],
        sleep: 250,
        maxJobs: 1,
        timeout: 5000,
        stopWhenEmpty: true,
      })
    } finally {
      await workspace.cleanup()
    }
  })

  it('retries failed jobs', async () => {
    const workspace = await createTempWorkspace('guren-cli-queue-retry-')
    try {
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'src/main.ts'),
        'export default { listen() {} }',
        'utf8',
      )

      await retryFailedJob('job-1')
      expect(fakeDriver.retryFailedJob).toHaveBeenCalledWith('job-1')
    } finally {
      await workspace.cleanup()
    }
  })

  it('flushes all failed jobs', async () => {
    const workspace = await createTempWorkspace('guren-cli-queue-flush-')
    try {
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'src/main.ts'),
        'export default { listen() {} }',
        'utf8',
      )

      fakeDriver.getFailedJobs = mock(async () => [
        { id: 'job-1' },
        { id: 'job-2' },
      ] as any)

      await retryAllFailedJobs()
      await flushFailedJobs()

      expect(fakeDriver.retryFailedJob).toHaveBeenCalledTimes(2)
      expect(fakeDriver.deleteFailedJob).toHaveBeenCalledTimes(2)
    } finally {
      await workspace.cleanup()
    }
  })
})
