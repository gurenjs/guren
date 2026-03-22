import { describe, test, expect } from 'bun:test'

import { createScheduleHandler } from '../../src/lambda'
import { Scheduler } from '../../src/scheduling/Scheduler'
import { Schedule } from '../../src/scheduling/Schedule'

describe('createScheduleHandler', () => {
  test('should return a function', () => {
    const scheduler = new Scheduler()
    const handler = createScheduleHandler(scheduler)

    expect(typeof handler).toBe('function')
  })

  test('should run due tasks when invoked', async () => {
    const scheduler = new Scheduler()
    let taskRan = false

    scheduler.schedule((schedule: Schedule) => {
      schedule.call(async () => {
        taskRan = true
      }).everyMinute().name('test-task')
    })

    const handler = createScheduleHandler(scheduler)
    await handler()

    expect(taskRan).toBe(true)
  })

  test('should not fail when no tasks are due', async () => {
    const scheduler = new Scheduler()

    // Schedule a task for a specific time that is not now
    scheduler.schedule((schedule: Schedule) => {
      schedule.call(async () => {
        // This should not run
      }).yearly().name('yearly-task')
    })

    const handler = createScheduleHandler(scheduler)

    // Should not throw
    await handler()
  })
})
