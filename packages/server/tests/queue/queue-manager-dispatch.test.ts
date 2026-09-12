import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Job, MemoryDriver, clearQueueDriver, createQueueManager, getQueueDriver } from '../../src/queue'
import { resetDefaultApplication } from '../../src/http/default-application'

class ReportJob extends Job<{ id: number }> {
  static override queue = 'reports'
  static override maxAttempts = 5

  async handle(): Promise<void> {}
}

describe('QueueManager.dispatch()', () => {
  beforeEach(() => {
    resetDefaultApplication()
    clearQueueDriver()
  })

  afterEach(() => {
    clearQueueDriver()
  })

  it('pushes the message Job.dispatch() would, through this manager\'s default driver', async () => {
    const driver = new MemoryDriver()
    const manager = createQueueManager({ default: 'memory', drivers: { memory: () => driver } })

    const id = await manager.dispatch(ReportJob, { id: 7 })

    expect(await driver.size('reports')).toBe(1)
    const job = await driver.pop('reports')
    expect(job).toMatchObject({ id, name: 'ReportJob', payload: { id: 7 }, queue: 'reports', maxAttempts: 5, attempts: 0 })
  })

  it('honours the per-dispatch queue and attempt overrides', async () => {
    const driver = new MemoryDriver()
    const manager = createQueueManager({ default: 'memory', drivers: { memory: () => driver } })

    await manager.dispatch(ReportJob, { id: 1 }, { queue: 'urgent', maxAttempts: 1 })

    expect(await driver.pop('urgent')).toMatchObject({ queue: 'urgent', maxAttempts: 1 })
  })

  it('touches neither the dispatch pin nor the default application', async () => {
    const manager = createQueueManager({ default: 'memory', drivers: { memory: () => new MemoryDriver() } })

    await manager.dispatch(ReportJob, { id: 1 })

    expect(getQueueDriver()).toBeNull()
    await expect(ReportJob.dispatch({ id: 2 })).rejects.toThrow('Queue driver not configured')
  })

  it('reports a default driver the manager has no factory for', async () => {
    const manager = createQueueManager({ default: 'sqs' })

    await expect(manager.dispatch(ReportJob, { id: 1 })).rejects.toThrow('Queue driver not found: sqs')
  })
})
