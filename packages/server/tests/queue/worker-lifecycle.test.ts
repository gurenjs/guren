import { describe, expect, test } from 'bun:test'
import { Job, enqueueJob, registerJob } from '../../src/queue/Job'
import { Worker } from '../../src/queue/Worker'
import { MemoryDriver } from '../../src/queue/drivers/MemoryDriver'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

describe('worker cancellation and recovery', () => {
  test('waits for an uncooperative handler before retrying and stopping', async () => {
    let active = 0, peak = 0, completed = 0
    class SlowJob extends Job {
      static backoff = 0
      async handle() {
        active++; peak = Math.max(peak, active)
        await sleep(25)
        completed++; active--
      }
    }
    registerJob(SlowJob)
    const driver = new MemoryDriver()
    await enqueueJob(driver, SlowJob, {}, { maxAttempts: 2 })
    await new Worker(driver, { timeout: 5, stopWhenEmpty: true }).start()
    expect({ peak, completed, active }).toEqual({ peak: 1, completed: 2, active: 0 })
    expect(await driver.getFailedJobs()).toHaveLength(1)
  })

  test('passes cancellation to cooperative I/O before applying failure policy', async () => {
    let cancelled = false
    class CancellableJob extends Job {
      async handle() {
        await new Promise<void>((_resolve, reject) => {
          this.signal.addEventListener('abort', () => { cancelled = true; reject(this.signal.reason) }, { once: true })
        })
      }
    }
    registerJob(CancellableJob)
    const driver = new MemoryDriver()
    await enqueueJob(driver, CancellableJob, {}, { maxAttempts: 1 })
    await new Worker(driver, { timeout: 5, stopWhenEmpty: true }).start()
    expect(cancelled).toBe(true)
    expect((await driver.getFailedJobs())[0]?.error).toContain('timed out')
  })

  test('resets lifecycle state after a driver error and can be restarted', async () => {
    let broken = true, stopped = 0
    class FlakyDriver extends MemoryDriver {
      override async pop() { if (broken) throw new Error('offline'); return null }
    }
    const worker = new Worker(new FlakyDriver(), { stopWhenEmpty: true }, { workerStopped: () => { stopped++ } })
    await expect(worker.start()).rejects.toThrow('offline')
    expect(worker.isRunning()).toBe(false)
    broken = false
    await worker.start()
    expect(worker.isRunning()).toBe(false)
    expect(stopped).toBe(2)
  })

  test('does not acknowledge or retry a job after losing its reservation', async () => {
    class LeaseJob extends Job { async handle() { await sleep(25) } }
    class LeaseDriver extends MemoryDriver {
      readonly heartbeatInterval = 1
      async extendReservation() { return false }
      override async release() { throw new Error('must not release') }
      override async delete() { throw new Error('must not delete') }
      override async fail() { throw new Error('must not fail') }
    }
    registerJob(LeaseJob)
    const driver = new LeaseDriver()
    await enqueueJob(driver, LeaseJob, {})
    const worker = new Worker(driver, { stopWhenEmpty: true })
    await expect(worker.start()).rejects.toThrow('reservation could not be renewed')
    expect(worker.isRunning()).toBe(false)
  })
})
