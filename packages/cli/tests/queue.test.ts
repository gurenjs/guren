import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTempWorkspace } from './helpers'

let workerOptions: Record<string, unknown> | undefined
let workerDriver: unknown
let fakeDriver: {
  getFailedJobs: ReturnType<typeof mock>
  retryFailedJob: ReturnType<typeof mock>
  deleteFailedJob: ReturnType<typeof mock>
}

await mock.module('../src/queue-deps', () => ({
  Worker: class {
    options: Record<string, unknown>
    events: Record<string, (...args: any[]) => void>

    constructor(driver: unknown, options: Record<string, unknown>, events: Record<string, (...args: any[]) => void>) {
      this.options = options
      this.events = events
      workerOptions = options
      workerDriver = driver
    }

    async start() {
      this.events.workerStarted?.()
    }

    async stop() {
      this.events.workerStopped?.()
    }
  },
  resolveQueueDriver: () => fakeDriver,
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
  workerDriver = undefined
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

  it('hands the worker the driver and container of the booted app (RFC 0023)', async () => {
    const workspace = await createTempWorkspace('guren-cli-queue-container-')
    try {
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'src/main.ts'),
        [
          "const driver = { name: 'bound' }",
          "const manager = { driver: () => driver, hasDriver: () => true, getDefaultDriverName: () => 'memory' }",
          '// Methods on the prototype reading `this`, as the real Container has them:',
          '// a container handed over by detaching them resolves nothing.',
          'class Container {',
          '  constructor(bindings) { this.bindings = bindings }',
          '  has(key) { return key in this.bindings }',
          '  make(key) { return this.bindings[key] }',
          '}',
          'export default {',
          '  listen() {},',
          "  container: new Container({ queue: manager, mail: { name: 'mailer' } }),",
          '}',
        ].join('\n'),
        'utf8',
      )

      await runQueueWorker({ once: true })

      const container = workerOptions?.container as { make: (key: string) => unknown } | undefined
      expect(workerDriver).toEqual({ name: 'bound' })
      expect(container?.make('mail')).toEqual({ name: 'mailer' })
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
