import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  Job,
  setQueueDriver,
  getQueueDriver,
  registerJob,
  getJob,
  clearJobRegistry,
  getRegisteredJobs,
  resolveJobName,
  MemoryDriver,
  SyncDriver,
  Worker,
  processJob,
  QueueManager,
  type JobClass,
} from '../../src/queue'

describe('Job', () => {
  let driver: MemoryDriver

  beforeEach(() => {
    driver = new MemoryDriver()
    setQueueDriver(driver)
    clearJobRegistry()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('Job base class', () => {
    it('has default static properties', () => {
      class TestJob extends Job<{ data: string }> {
        handle() {}
      }

      expect(TestJob.queue).toBe('default')
      expect(TestJob.maxAttempts).toBe(3)
      expect(TestJob.backoff).toBe('exponential')
    })

    it('can override static properties', () => {
      class EmailJob extends Job<{ email: string }> {
        static queue = 'emails'
        static maxAttempts = 5
        static backoff: 'linear' = 'linear'

        handle() {}
      }

      expect(EmailJob.queue).toBe('emails')
      expect(EmailJob.maxAttempts).toBe(5)
      expect(EmailJob.backoff).toBe('linear')
    })
  })

  describe('dispatch', () => {
    it('dispatches a job to the queue', async () => {
      class TestJob extends Job<{ message: string }> {
        handle() {}
      }

      const jobId = await TestJob.dispatch({ message: 'hello' })

      expect(jobId).toBeDefined()
      expect(typeof jobId).toBe('string')
      expect(await driver.size('default')).toBe(1)
    })

    it('uses custom queue from options', async () => {
      class TestJob extends Job<{ data: number }> {
        handle() {}
      }

      await TestJob.dispatch({ data: 42 }, { queue: 'high-priority' })

      expect(await driver.size('default')).toBe(0)
      expect(await driver.size('high-priority')).toBe(1)
    })

    it('uses class queue by default', async () => {
      class EmailJob extends Job<{ to: string }> {
        static queue = 'emails'
        handle() {}
      }

      await EmailJob.dispatch({ to: 'test@example.com' })

      expect(await driver.size('emails')).toBe(1)
    })

    it('throws if no driver is configured', async () => {
      setQueueDriver(null as any)

      class TestJob extends Job<void> {
        handle() {}
      }

      await expect(TestJob.dispatch(undefined as any)).rejects.toThrow(
        'Queue driver not configured'
      )
    })
  })

  describe('dispatchAfter', () => {
    it('dispatches a job with delay', async () => {
      class TestJob extends Job<{ id: number }> {
        handle() {}
      }

      const beforeDispatch = Date.now()
      await TestJob.dispatchAfter(5000, { id: 1 })

      const jobs = driver.getPendingJobs()
      expect(jobs).toHaveLength(1)
      expect(jobs[0].availableAt.getTime()).toBeGreaterThanOrEqual(beforeDispatch + 5000)
    })
  })

  describe('calculateRetryDelay', () => {
    it('calculates exponential backoff', () => {
      class TestJob extends Job<void> {
        static backoff: 'exponential' = 'exponential'
        handle() {}
      }

      expect(TestJob.calculateRetryDelay(1)).toBe(2000) // 2^1 * 1000
      expect(TestJob.calculateRetryDelay(2)).toBe(4000) // 2^2 * 1000
      expect(TestJob.calculateRetryDelay(3)).toBe(8000) // 2^3 * 1000
    })

    it('calculates linear backoff', () => {
      class TestJob extends Job<void> {
        static backoff: 'linear' = 'linear'
        handle() {}
      }

      expect(TestJob.calculateRetryDelay(1)).toBe(1000) // 1 * 1000
      expect(TestJob.calculateRetryDelay(2)).toBe(2000) // 2 * 1000
      expect(TestJob.calculateRetryDelay(3)).toBe(3000) // 3 * 1000
    })

    it('uses fixed delay', () => {
      class TestJob extends Job<void> {
        static backoff = 5000
        handle() {}
      }

      expect(TestJob.calculateRetryDelay(1)).toBe(5000)
      expect(TestJob.calculateRetryDelay(2)).toBe(5000)
      expect(TestJob.calculateRetryDelay(3)).toBe(5000)
    })
  })
})

describe('Job Registry', () => {
  beforeEach(() => {
    clearJobRegistry()
  })

  it('registers and retrieves job classes', () => {
    class SendEmailJob extends Job<{ email: string }> {
      handle() {}
    }

    registerJob(SendEmailJob)

    const found = getJob('SendEmailJob')
    expect(found).toBe(SendEmailJob)
  })

  it('returns undefined for unregistered jobs', () => {
    const found = getJob('NonExistentJob')
    expect(found).toBeUndefined()
  })

  it('lists all registered jobs', () => {
    class JobA extends Job<void> {
      handle() {}
    }
    class JobB extends Job<void> {
      handle() {}
    }

    registerJob(JobA)
    registerJob(JobB)

    const jobs = getRegisteredJobs()
    expect(jobs.size).toBe(2)
    expect(jobs.has('JobA')).toBe(true)
    expect(jobs.has('JobB')).toBe(true)
  })

  it('clears the registry', () => {
    class TestJob extends Job<void> {
      handle() {}
    }

    registerJob(TestJob)
    expect(getRegisteredJobs().size).toBe(1)

    clearJobRegistry()
    expect(getRegisteredJobs().size).toBe(0)
  })
})

describe('Job wire name', () => {
  let driver: MemoryDriver

  beforeEach(() => {
    driver = new MemoryDriver()
    setQueueDriver(driver)
    clearJobRegistry()
  })

  it('resolves, registers and dispatches by class name when jobName is not declared', async () => {
    class PlainJob extends Job<void> {
      handle() {}
    }

    expect(resolveJobName(PlainJob)).toBe('PlainJob')

    registerJob(PlainJob)
    expect(getJob('PlainJob')).toBe(PlainJob)

    await PlainJob.dispatch(undefined)
    const queued = await driver.pop('default')
    expect(queued?.name).toBe('PlainJob')
  })

  it('prefers an explicit jobName over the class name', () => {
    class MangledName extends Job<void> {
      static jobName = 'StableJob'
      handle() {}
    }

    expect(resolveJobName(MangledName)).toBe('StableJob')

    registerJob(MangledName)
    expect(getJob('StableJob')).toBe(MangledName)
    expect(getJob('MangledName')).toBeUndefined()
  })

  it('dispatches and resolves round-trip under the declared jobName', async () => {
    const handled: string[] = []

    class MangledName extends Job<{ id: string }> {
      static jobName = 'StableJob'
      handle(payload: { id: string }) {
        handled.push(payload.id)
      }
    }

    registerJob(MangledName)
    await MangledName.dispatch({ id: 'abc' })

    const queued = await driver.pop('default')
    expect(queued?.name).toBe('StableJob')

    // Simulate the worker resolving a message written by an earlier deploy.
    const Resolved = getJob(queued!.name)
    expect(Resolved).toBe(MangledName as unknown as JobClass)
    await new Resolved!().handle(queued!.payload)
    expect(handled).toEqual(['abc'])
  })

  it('does not let a subclass inherit its parent jobName', () => {
    class BaseJob extends Job<void> {
      static jobName = 'StableBase'
      handle() {}
    }
    class DerivedJob extends BaseJob {}

    // Statics are inherited, so `DerivedJob.jobName` reads 'StableBase' — but
    // resolution must ignore it, or registering the subclass would evict the
    // parent from the registry under a name it never declared.
    expect(DerivedJob.jobName).toBe('StableBase')
    expect(resolveJobName(DerivedJob)).toBe('DerivedJob')

    registerJob(BaseJob)
    registerJob(DerivedJob)

    expect(getRegisteredJobs().size).toBe(2)
    expect(getJob('StableBase')).toBe(BaseJob as unknown as JobClass)
    expect(getJob('DerivedJob')).toBe(DerivedJob as unknown as JobClass)
  })

  it('lets a subclass opt back into its parent name by declaring it', () => {
    class BaseJob extends Job<void> {
      static jobName = 'StableBase'
      handle() {}
    }
    class BoundJob extends BaseJob {
      static override jobName = BaseJob.jobName
    }

    registerJob(BoundJob)
    expect(getJob('StableBase')).toBe(BoundJob as unknown as JobClass)
  })
})

describe('MemoryDriver', () => {
  let driver: MemoryDriver

  beforeEach(() => {
    driver = new MemoryDriver()
  })

  it('pushes and pops jobs', async () => {
    const job = {
      id: 'job-1',
      name: 'TestJob',
      payload: { data: 'test' },
      queue: 'default',
      attempts: 0,
      maxAttempts: 3,
      availableAt: new Date(),
      createdAt: new Date(),
      reservedAt: null,
    }

    await driver.push(job)
    expect(await driver.size('default')).toBe(1)

    const popped = await driver.pop('default')
    expect(popped).not.toBeNull()
    expect(popped!.id).toBe('job-1')
    expect(popped!.reservedAt).not.toBeNull()
  })

  it('returns null when queue is empty', async () => {
    const job = await driver.pop('default')
    expect(job).toBeNull()
  })

  it('respects availableAt time', async () => {
    const futureDate = new Date(Date.now() + 10000)
    const job = {
      id: 'job-1',
      name: 'TestJob',
      payload: {},
      queue: 'default',
      attempts: 0,
      maxAttempts: 3,
      availableAt: futureDate,
      createdAt: new Date(),
      reservedAt: null,
    }

    await driver.push(job)
    const popped = await driver.pop('default')
    expect(popped).toBeNull()
  })

  it('releases jobs back to the queue', async () => {
    const job = {
      id: 'job-1',
      name: 'TestJob',
      payload: {},
      queue: 'default',
      attempts: 1,
      maxAttempts: 3,
      availableAt: new Date(),
      createdAt: new Date(),
      reservedAt: null,
    }

    await driver.push(job)
    const popped = await driver.pop('default')
    expect(popped).not.toBeNull()

    await driver.release(popped!, 0)
    const released = await driver.pop('default')
    expect(released).not.toBeNull()
    expect(released!.attempts).toBe(1)
  })

  it('deletes jobs', async () => {
    const job = {
      id: 'job-1',
      name: 'TestJob',
      payload: {},
      queue: 'default',
      attempts: 0,
      maxAttempts: 3,
      availableAt: new Date(),
      createdAt: new Date(),
      reservedAt: null,
    }

    await driver.push(job)
    await driver.delete('job-1')
    expect(await driver.size('default')).toBe(0)
  })

  it('fails jobs', async () => {
    const job = {
      id: 'job-1',
      name: 'TestJob',
      payload: {},
      queue: 'default',
      attempts: 3,
      maxAttempts: 3,
      availableAt: new Date(),
      createdAt: new Date(),
      reservedAt: null,
    }

    await driver.push(job)
    const popped = await driver.pop('default')
    await driver.fail(popped!, new Error('Test error'))

    expect(await driver.size('default')).toBe(0)

    const failed = await driver.getFailedJobs()
    expect(failed).toHaveLength(1)
    expect(failed[0].error).toBe('Test error')
  })

  it('retries failed jobs', async () => {
    const job = {
      id: 'job-1',
      name: 'TestJob',
      payload: {},
      queue: 'default',
      attempts: 3,
      maxAttempts: 3,
      availableAt: new Date(),
      createdAt: new Date(),
      reservedAt: null,
    }

    await driver.push(job)
    const popped = await driver.pop('default')
    await driver.fail(popped!, new Error('Test error'))

    await driver.retryFailedJob('job-1')

    expect(await driver.size('default')).toBe(1)
    expect((await driver.getFailedJobs()).length).toBe(0)
  })

  it('throws when retrying non-existent failed job', async () => {
    await expect(driver.retryFailedJob('non-existent')).rejects.toThrow(
      'Failed job not found'
    )
  })

  it('clears all jobs', async () => {
    const job = {
      id: 'job-1',
      name: 'TestJob',
      payload: {},
      queue: 'default',
      attempts: 0,
      maxAttempts: 3,
      availableAt: new Date(),
      createdAt: new Date(),
      reservedAt: null,
    }

    await driver.push(job)
    await driver.clear()
    expect(await driver.size('default')).toBe(0)
  })
})

describe('Worker', () => {
  let driver: MemoryDriver
  const handledPayloads: any[] = []

  class ProcessableJob extends Job<{ value: number }> {
    async handle(payload: { value: number }) {
      handledPayloads.push(payload)
    }
  }

  beforeEach(() => {
    driver = new MemoryDriver()
    setQueueDriver(driver)
    clearJobRegistry()
    handledPayloads.length = 0
    registerJob(ProcessableJob)
  })

  it('processes jobs from the queue', async () => {
    await ProcessableJob.dispatch({ value: 42 })
    await ProcessableJob.dispatch({ value: 100 })

    const worker = new Worker(driver, { maxJobs: 2 })
    await worker.start()

    expect(handledPayloads).toHaveLength(2)
    expect(handledPayloads).toContainEqual({ value: 42 })
    expect(handledPayloads).toContainEqual({ value: 100 })
  })

  it('respects maxJobs limit', async () => {
    await ProcessableJob.dispatch({ value: 1 })
    await ProcessableJob.dispatch({ value: 2 })
    await ProcessableJob.dispatch({ value: 3 })

    const worker = new Worker(driver, { maxJobs: 2 })
    await worker.start()

    expect(handledPayloads).toHaveLength(2)
    expect(await driver.size('default')).toBe(1)
  })

  it('processes jobs from multiple queues', async () => {
    class HighPriorityJob extends Job<{ priority: string }> {
      static queue = 'high'
      async handle(payload: { priority: string }) {
        handledPayloads.push(payload)
      }
    }

    registerJob(HighPriorityJob)

    await ProcessableJob.dispatch({ value: 1 })
    await HighPriorityJob.dispatch({ priority: 'urgent' })

    const worker = new Worker(driver, {
      queues: ['high', 'default'],
      maxJobs: 2,
    })
    await worker.start()

    expect(handledPayloads).toHaveLength(2)
    expect(handledPayloads[0]).toEqual({ priority: 'urgent' }) // high priority first
  })

  it('emits jobProcessed event', async () => {
    const processedJobs: any[] = []

    await ProcessableJob.dispatch({ value: 42 })

    const worker = new Worker(
      driver,
      { maxJobs: 1 },
      { jobProcessed: (job) => { processedJobs.push(job) } }
    )
    await worker.start()

    expect(processedJobs).toHaveLength(1)
    expect(processedJobs[0].name).toBe('ProcessableJob')
  })

  it('retries failed jobs', async () => {
    let attempts = 0

    class FailingJob extends Job<void> {
      static maxAttempts = 3
      static backoff = 0 // No delay for testing
      async handle() {
        attempts++
        if (attempts < 3) {
          throw new Error('Temporary error')
        }
      }
    }

    registerJob(FailingJob)
    await FailingJob.dispatch(undefined as any)

    // Process multiple times to allow retries
    for (let i = 0; i < 5; i++) {
      const worker = new Worker(driver, { maxJobs: 1, stopWhenEmpty: true })
      await worker.start()
      if (await driver.size('default') === 0) break
    }

    expect(attempts).toBe(3)
  })

  it('moves to failed after max attempts', async () => {
    class AlwaysFailsJob extends Job<void> {
      static maxAttempts = 2
      static backoff = 0 // No delay for testing
      async handle() {
        throw new Error('Always fails')
      }
    }

    registerJob(AlwaysFailsJob)
    await AlwaysFailsJob.dispatch(undefined as any)

    // Process until failed
    for (let i = 0; i < 3; i++) {
      const worker = new Worker(driver, { maxJobs: 1, stopWhenEmpty: true })
      await worker.start()
    }

    const failed = await driver.getFailedJobs()
    expect(failed).toHaveLength(1)
    expect(failed[0].error).toBe('Always fails')
  })

  it('calls failed() handler when job fails permanently', async () => {
    const failedPayloads: any[] = []

    class JobWithFailedHandler extends Job<{ id: number }> {
      static maxAttempts = 1
      async handle() {
        throw new Error('Failed')
      }
      async failed(payload: { id: number }) {
        failedPayloads.push(payload)
      }
    }

    registerJob(JobWithFailedHandler)
    await JobWithFailedHandler.dispatch({ id: 123 })

    const worker = new Worker(driver, { maxJobs: 1 })
    await worker.start()

    expect(failedPayloads).toHaveLength(1)
    expect(failedPayloads[0]).toEqual({ id: 123 })
  })

  it('stops gracefully', async () => {
    await ProcessableJob.dispatch({ value: 1 })

    const worker = new Worker(driver, { sleep: 100 })

    // Start and stop
    const startPromise = worker.start()
    await new Promise((r) => setTimeout(r, 50))
    await worker.stop()
    await startPromise

    expect(worker.isRunning()).toBe(false)
  })
})

describe('processJob helper', () => {
  let driver: MemoryDriver
  let handled = false

  class SimpleJob extends Job<void> {
    async handle() {
      handled = true
    }
  }

  beforeEach(() => {
    driver = new MemoryDriver()
    setQueueDriver(driver)
    clearJobRegistry()
    handled = false
    registerJob(SimpleJob)
  })

  it('processes a single job', async () => {
    await SimpleJob.dispatch(undefined as any)

    const result = await processJob(driver, 'default')

    expect(result).toBe(true)
    expect(handled).toBe(true)
  })

  it('returns false when no jobs available', async () => {
    const result = await processJob(driver, 'default')

    expect(result).toBe(false)
    expect(handled).toBe(false)
  })
})

describe('QueueManager', () => {
  it('creates with default configuration', () => {
    const manager = new QueueManager()
    expect(manager.getDefaultDriverName()).toBe('memory')
  })

  it('gets driver by name', () => {
    const memoryDriver = new MemoryDriver()

    const manager = new QueueManager({
      default: 'memory',
      drivers: {
        memory: () => memoryDriver,
      },
    })

    const driver = manager.driver('memory')
    expect(driver).toBe(memoryDriver)
  })

  it('returns default driver when no name specified', () => {
    const memoryDriver = new MemoryDriver()

    const manager = new QueueManager({
      default: 'memory',
      drivers: {
        memory: () => memoryDriver,
      },
    })

    expect(manager.driver()).toBe(memoryDriver)
  })

  it('caches resolved drivers', () => {
    let callCount = 0

    const manager = new QueueManager({
      drivers: {
        memory: () => {
          callCount++
          return new MemoryDriver()
        },
      },
    })

    manager.driver('memory')
    manager.driver('memory')
    manager.driver('memory')

    expect(callCount).toBe(1)
  })

  it('throws for unknown driver', () => {
    const manager = new QueueManager()

    expect(() => manager.driver('unknown')).toThrow('Queue driver not found: unknown')
  })

  it('registers custom drivers', () => {
    const manager = new QueueManager()
    const customDriver = new MemoryDriver()

    manager.registerDriver('custom', () => customDriver)

    expect(manager.driver('custom')).toBe(customDriver)
  })

  it('checks if driver exists', () => {
    const manager = new QueueManager({
      drivers: {
        memory: () => new MemoryDriver(),
      },
    })

    expect(manager.hasDriver('memory')).toBe(true)
    expect(manager.hasDriver('unknown')).toBe(false)
  })

  it('lists driver names', () => {
    const manager = new QueueManager({
      drivers: {
        memory: () => new MemoryDriver(),
        test: () => new MemoryDriver(),
      },
    })

    const names = manager.getDriverNames()
    expect(names).toContain('memory')
    expect(names).toContain('test')
  })

  it('sets default driver and updates global', () => {
    const manager = new QueueManager({
      drivers: {
        memory: () => new MemoryDriver(),
        other: () => new MemoryDriver(),
      },
    })

    manager.setDefaultDriver('other')
    const globalDriver = getQueueDriver()

    expect(globalDriver).toBe(manager.driver('other'))
  })

  it('resolves the new default from driver() after setDefaultDriver', () => {
    const memoryDriver = new MemoryDriver()
    const otherDriver = new MemoryDriver()
    const manager = new QueueManager({
      default: 'memory',
      drivers: {
        memory: () => memoryDriver,
        other: () => otherDriver,
      },
    })

    // Resolve the old default first so the instance default, not a fresh
    // cache, is what the assertions below observe.
    expect(manager.driver()).toBe(memoryDriver)

    manager.setDefaultDriver('other')

    expect(manager.getDefaultDriverName()).toBe('other')
    expect(manager.driver()).toBe(otherDriver)
    expect(getQueueDriver()).toBe(otherDriver)
  })

  it('publishes an already-resolved driver as the global when it becomes the default', () => {
    const memoryDriver = new MemoryDriver()
    const otherDriver = new MemoryDriver()
    const manager = new QueueManager({
      default: 'memory',
      drivers: {
        memory: () => memoryDriver,
        other: () => otherDriver,
      },
    })

    manager.driver()
    manager.driver('other') // cached under its name, not yet the global
    expect(getQueueDriver()).toBe(memoryDriver)

    manager.setDefaultDriver('other')

    expect(getQueueDriver()).toBe(otherDriver)
  })

  it('rejects an unknown driver without changing the default', () => {
    const manager = new QueueManager({
      drivers: { memory: () => new MemoryDriver() },
    })

    expect(() => manager.setDefaultDriver('unknown')).toThrow('Queue driver not found: unknown')
    expect(manager.getDefaultDriverName()).toBe('memory')
  })
})

describe('SyncDriver', () => {
  let driver: SyncDriver

  beforeEach(() => {
    driver = new SyncDriver()
    setQueueDriver(driver)
    clearJobRegistry()
  })

  function queuedJob(name: string) {
    return {
      id: 'job-1',
      name,
      payload: {},
      queue: 'default',
      attempts: 1,
      maxAttempts: 3,
      availableAt: new Date(),
      createdAt: new Date(),
      reservedAt: null,
    }
  }

  it('runs the job inline on dispatch and surfaces the failure from dispatch()', async () => {
    class FailingJob extends Job<void> {
      async handle() {
        throw new Error('inline failure')
      }
    }
    registerJob(FailingJob)

    await expect(FailingJob.dispatch(undefined as any)).rejects.toThrow('inline failure')

    const failed = await driver.getFailedJobs()
    expect(failed).toHaveLength(1)
    expect(failed[0].attempts).toBe(1)
  })

  it('release() re-runs the job immediately, ignoring the retry delay', async () => {
    const ran: number[] = []
    class RetriedJob extends Job<void> {
      async handle() {
        ran.push(Date.now())
      }
    }
    registerJob(RetriedJob)

    const job = queuedJob('RetriedJob')
    const started = Date.now()
    await driver.release(job, 5_000)

    expect(ran).toHaveLength(1)
    expect(ran[0] - started).toBeLessThan(1_000)
    expect(job.attempts).toBe(2)
  })

  it('release() rethrows a retry that fails, like push()', async () => {
    class StillFailingJob extends Job<void> {
      async handle() {
        throw new Error('still failing')
      }
    }
    registerJob(StillFailingJob)

    await expect(driver.release(queuedJob('StillFailingJob'), 5_000)).rejects.toThrow(
      'still failing'
    )
    expect(await driver.getFailedJobs()).toHaveLength(1)
  })
})
