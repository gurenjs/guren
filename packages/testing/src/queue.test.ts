import { describe, expect, it } from 'vitest'
import { Job } from '@guren/server'
import { FakeQueue } from './queue'

class TestJob extends Job<{ id: number }> {
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
})
