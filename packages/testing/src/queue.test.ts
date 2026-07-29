import { describe, expect, it } from 'vitest'
import { Job } from '@guren/server'
import { FakeQueue } from './queue'

class TestJob extends Job<{ id: number }> {
  static override queue = 'default'
  async handle(_payload: { id: number }): Promise<void> {}
}

class RenamedJob extends Job<{ id: number }> {
  static override jobName = 'StableTestJob'
  static override queue = 'default'
  async handle(_payload: { id: number }): Promise<void> {}
}

describe('FakeQueue', () => {
  it('records pushed jobs', () => {
    const queue = new FakeQueue()

    queue.record(TestJob, { id: 1 }, { queue: 'critical', delay: 5 })

    expect(queue.pushed(TestJob)).toHaveLength(1)
    expect(queue.pushed(TestJob)[0].options.queue).toBe('critical')
  })

  it('asserts expected pushes', () => {
    const queue = new FakeQueue()

    queue.record(TestJob, { id: 2 })

    expect(() => queue.assertPushed(TestJob)).not.toThrow()
    expect(() => queue.assertPushedTimes(TestJob, 1)).not.toThrow()
    expect(() => queue.assertPushedOn('default', TestJob)).not.toThrow()
    expect(() => queue.assertPushedOn('critical', TestJob)).toThrow()
  })

  it('records a job declaring jobName under its wire name', () => {
    const queue = new FakeQueue()

    queue.record(RenamedJob, { id: 3 })

    const [recorded] = queue.all()
    expect(recorded.queuedJob.name).toBe('StableTestJob')
    expect(recorded.jobClass).toBe(RenamedJob)
    expect(queue.pushed(RenamedJob)).toHaveLength(1)
  })

  it('reports the wire name when an assertion fails', () => {
    const queue = new FakeQueue()

    // The failure message has to name the string the queue actually keys on.
    // 'RenamedJob' appears nowhere in the driver, so reporting it would send
    // whoever reads the failure looking for something that does not exist.
    expect(() => queue.assertPushed(RenamedJob)).toThrow(/StableTestJob/)

    queue.record(RenamedJob, { id: 4 })
    expect(() => queue.assertNotPushed(RenamedJob)).toThrow(/StableTestJob/)
    expect(() => queue.assertPushedTimes(RenamedJob, 2)).toThrow(/StableTestJob/)
    expect(() => queue.assertPushedOn('critical', RenamedJob)).toThrow(/StableTestJob/)
  })

  it('matches a message pushed by the real driver under its wire name', async () => {
    const queue = new FakeQueue()
    const now = new Date()

    // A message as a real driver would have written it: it carries the wire
    // name, and nothing links it back to the class. Looking it up by
    // `RenamedJob.name` ('RenamedJob') would miss.
    await queue.getDriver().push({
      id: 'external-1',
      name: 'StableTestJob',
      payload: { id: 5 },
      queue: 'default',
      attempts: 0,
      maxAttempts: 3,
      availableAt: now,
      createdAt: now,
      reservedAt: null,
    })

    expect(queue.pushed(RenamedJob)).toHaveLength(1)
    expect(() => queue.assertPushed(RenamedJob)).not.toThrow()
    expect(() => queue.assertNotPushed(TestJob)).not.toThrow()
  })
})
