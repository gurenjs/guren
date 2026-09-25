import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { runCommand } from 'citty'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTempWorkspace } from './helpers'

let workerOptions: Record<string, unknown> | undefined
let workerDriver: unknown
let startWorker: (() => Promise<void>) | undefined
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
      await startWorker?.()
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
const { builtinSubCommands } = await import('../src/commands')

beforeEach(() => {
  fakeDriver = {
    getFailedJobs: mock(async () => []),
    retryFailedJob: mock(async () => {}),
    deleteFailedJob: mock(async () => {}),
  }
  workerOptions = undefined
  workerDriver = undefined
  startWorker = undefined
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

  it('queue:work --stop-when-empty exits on empty queues without capping the job count', async () => {
    const workspace = await createTempWorkspace('guren-cli-queue-stop-when-empty-')
    try {
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await writeFile(join(workspace.dir, 'src/main.ts'), 'export default { listen() {} }', 'utf8')

      await runCommand(builtinSubCommands['queue:work'], { rawArgs: ['--stop-when-empty'] })

      expect(workerOptions).toMatchObject({ maxJobs: 0, stopWhenEmpty: true })
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

  it('boots a default application before resolving its queue binding', async () => {
    const workspace = await createTempWorkspace('guren-cli-queue-boot-')
    try {
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await writeFile(join(workspace.dir, 'src/main.ts'), `
        const driver = { name: 'registered-during-boot' }
        const manager = { driver: () => driver, hasDriver: () => true, getDefaultDriverName: () => 'memory' }
        export default {
          listen() {},
          boot() { this.container = { has: () => true, make: () => manager } },
        }
      `)
      await runQueueWorker({ once: true })
      expect(workerDriver).toEqual({ name: 'registered-during-boot' })
    } finally {
      await workspace.cleanup()
    }
  })

  it('does not start a worker after application boot fails', async () => {
    const workspace = await createTempWorkspace('guren-cli-queue-boot-failure-')
    try {
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await writeFile(join(workspace.dir, 'src/main.ts'), `export default { listen() {}, boot() { throw new Error('provider failed') } }`)
      await expect(runQueueWorker({ once: true })).rejects.toThrow('provider failed')
      expect(workerDriver).toBeUndefined()
    } finally {
      await workspace.cleanup()
    }
  })

  for (const failure of [false, true]) {
    it(`removes its signal handlers when the worker ${failure ? 'fails' : 'finishes'}`, async () => {
      const workspace = await createTempWorkspace('guren-cli-queue-lifetime-')
      const before = { SIGINT: process.listeners('SIGINT'), SIGTERM: process.listeners('SIGTERM') }
      try {
        await mkdir(join(workspace.dir, 'src'), { recursive: true })
        await writeFile(join(workspace.dir, 'src/main.ts'), 'export default { listen() {} }')
        startWorker = async () => { if (failure) throw new Error('poll failed') }
        if (failure) await expect(runQueueWorker()).rejects.toThrow('poll failed')
        else await runQueueWorker({ once: true })
        expect(process.listeners('SIGINT')).toEqual(before.SIGINT)
        expect(process.listeners('SIGTERM')).toEqual(before.SIGTERM)
      } finally {
        // Also clean up against the pre-fix implementation so a failing regression
        // cannot leave callbacks pointing at a completed test's worker.
        for (const signal of ['SIGINT', 'SIGTERM'] as const) {
          for (const listener of process.listeners(signal)) {
            if (!before[signal].includes(listener)) process.removeListener(signal, listener)
          }
        }
        await workspace.cleanup()
      }
    })
  }

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
