import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  parseCron,
  matchesCron,
  getNextOccurrence,
  isDue,
  PendingSchedule,
  Schedule,
  ScheduledTask,
  Scheduler,
  createScheduler,
} from '../../src/scheduling'

describe('CronParser', () => {
  describe('parseCron', () => {
    it('parses wildcard expression', () => {
      const parsed = parseCron('* * * * *')
      expect(parsed.minute).toHaveLength(60)
      expect(parsed.hour).toHaveLength(24)
      expect(parsed.dayOfMonth).toHaveLength(31)
      expect(parsed.month).toHaveLength(12)
      expect(parsed.dayOfWeek).toHaveLength(7)
    })

    it('parses specific values', () => {
      const parsed = parseCron('30 14 15 6 3')
      expect(parsed.minute).toEqual([30])
      expect(parsed.hour).toEqual([14])
      expect(parsed.dayOfMonth).toEqual([15])
      expect(parsed.month).toEqual([6])
      expect(parsed.dayOfWeek).toEqual([3])
    })

    it('parses step values', () => {
      const parsed = parseCron('*/15 * * * *')
      expect(parsed.minute).toEqual([0, 15, 30, 45])
    })

    it('parses range values', () => {
      const parsed = parseCron('0 9-17 * * *')
      expect(parsed.hour).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17])
    })

    it('parses comma-separated values', () => {
      const parsed = parseCron('0 9,12,18 * * *')
      expect(parsed.hour).toEqual([9, 12, 18])
    })

    it('parses range with step', () => {
      const parsed = parseCron('0 0-23/2 * * *')
      expect(parsed.hour).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22])
    })

    it('throws for invalid expression', () => {
      expect(() => parseCron('invalid')).toThrow()
      expect(() => parseCron('* * *')).toThrow()
    })
  })

  describe('matchesCron', () => {
    it('matches exact time', () => {
      const date = new Date(2024, 5, 15, 14, 30) // June 15, 2024, 14:30
      const cron = parseCron('30 14 15 6 *')
      expect(matchesCron(date, cron)).toBe(true)
    })

    it('does not match wrong minute', () => {
      const date = new Date(2024, 5, 15, 14, 31)
      const cron = parseCron('30 14 15 6 *')
      expect(matchesCron(date, cron)).toBe(false)
    })

    it('matches every minute', () => {
      const date = new Date()
      const cron = parseCron('* * * * *')
      expect(matchesCron(date, cron)).toBe(true)
    })
  })

  describe('getNextOccurrence', () => {
    it('gets next occurrence', () => {
      const from = new Date(2024, 5, 15, 14, 29) // 14:29
      const next = getNextOccurrence('30 14 * * *', from)
      expect(next.getHours()).toBe(14)
      expect(next.getMinutes()).toBe(30)
    })

    it('moves to next day if past time', () => {
      const from = new Date(2024, 5, 15, 14, 31) // 14:31
      const next = getNextOccurrence('30 14 * * *', from)
      expect(next.getDate()).toBe(16) // Next day
      expect(next.getHours()).toBe(14)
      expect(next.getMinutes()).toBe(30)
    })
  })

  describe('isDue', () => {
    it('returns true when due', () => {
      const date = new Date()
      date.setSeconds(0)
      date.setMilliseconds(0)

      const minute = date.getMinutes()
      const hour = date.getHours()
      expect(isDue(`${minute} ${hour} * * *`, date)).toBe(true)
    })

    it('returns false when not due', () => {
      const date = new Date()
      const wrongMinute = (date.getMinutes() + 1) % 60
      expect(isDue(`${wrongMinute} * * * *`, date)).toBe(false)
    })
  })
})

describe('PendingSchedule', () => {
  describe('frequency methods', () => {
    it('sets everyMinute', () => {
      const pending = new PendingSchedule(async () => {})
      pending.everyMinute()
      const def = pending.build()
      expect(def.expression).toBe('* * * * *')
    })

    it('sets everyFiveMinutes', () => {
      const pending = new PendingSchedule(async () => {})
      pending.everyFiveMinutes()
      const def = pending.build()
      expect(def.expression).toBe('*/5 * * * *')
    })

    it('sets hourly', () => {
      const pending = new PendingSchedule(async () => {})
      pending.hourly()
      const def = pending.build()
      expect(def.expression).toBe('0 * * * *')
    })

    it('sets hourlyAt', () => {
      const pending = new PendingSchedule(async () => {})
      pending.hourlyAt(30)
      const def = pending.build()
      expect(def.expression).toBe('30 * * * *')
    })

    it('sets daily', () => {
      const pending = new PendingSchedule(async () => {})
      pending.daily()
      const def = pending.build()
      expect(def.expression).toBe('0 0 * * *')
    })

    it('sets dailyAt', () => {
      const pending = new PendingSchedule(async () => {})
      pending.dailyAt('09:30')
      const def = pending.build()
      expect(def.expression).toBe('30 9 * * *')
    })

    it('sets weekly', () => {
      const pending = new PendingSchedule(async () => {})
      pending.weekly()
      const def = pending.build()
      expect(def.expression).toBe('0 0 * * 0')
    })

    it('sets weeklyOn', () => {
      const pending = new PendingSchedule(async () => {})
      pending.weeklyOn(1, '09:00')
      const def = pending.build()
      expect(def.expression).toBe('0 9 * * 1')
    })

    it('sets monthly', () => {
      const pending = new PendingSchedule(async () => {})
      pending.monthly()
      const def = pending.build()
      expect(def.expression).toBe('0 0 1 * *')
    })

    it('sets cron expression', () => {
      const pending = new PendingSchedule(async () => {})
      pending.cron('15 10 * * 1-5')
      const def = pending.build()
      expect(def.expression).toBe('15 10 * * 1-5')
    })
  })

  describe('day of week methods', () => {
    it('sets mondays', () => {
      const pending = new PendingSchedule(async () => {})
      pending.daily().at('09:00').mondays()
      const def = pending.build()
      expect(def.expression).toBe('0 9 * * 1')
    })

    it('sets weekdays', () => {
      const pending = new PendingSchedule(async () => {})
      pending.daily().at('09:00').weekdays()
      const def = pending.build()
      expect(def.expression).toBe('0 9 * * 1-5')
    })

    it('sets weekends', () => {
      const pending = new PendingSchedule(async () => {})
      pending.daily().at('09:00').weekends()
      const def = pending.build()
      expect(def.expression).toBe('0 9 * * 0,6')
    })
  })

  describe('configuration methods', () => {
    it('sets name', () => {
      const pending = new PendingSchedule(async () => {})
      pending.name('my-task')
      const def = pending.build()
      expect(def.name).toBe('my-task')
    })

    it('sets timezone', () => {
      const pending = new PendingSchedule(async () => {})
      pending.tz('Asia/Tokyo')
      const def = pending.build()
      expect(def.timezone).toBe('Asia/Tokyo')
    })

    it('sets preventOverlapping', () => {
      const pending = new PendingSchedule(async () => {})
      pending.preventOverlapping(60000)
      const def = pending.build()
      expect(def.withoutOverlapping).toBe(true)
      expect(def.overlapExpiresAt).toBe(60000)
    })

    it('sets callbacks', () => {
      const before = vi.fn()
      const after = vi.fn()
      const onSuccess = vi.fn()
      const onFailure = vi.fn()

      const pending = new PendingSchedule(async () => {})
      pending.before(before).after(after).onSuccess(onSuccess).onFailure(onFailure)

      const def = pending.build()
      expect(def.before).toBe(before)
      expect(def.after).toBe(after)
      expect(def.onSuccess).toBe(onSuccess)
      expect(def.onFailure).toBe(onFailure)
    })
  })
})

describe('Schedule', () => {
  it('creates tasks with call', () => {
    const schedule = new Schedule()
    schedule.call(async () => {}).everyMinute().name('task1')
    schedule.call(async () => {}).hourly().name('task2')

    const tasks = schedule.buildTasks()
    expect(tasks).toHaveLength(2)
    expect(tasks[0].getName()).toBe('task1')
    expect(tasks[1].getName()).toBe('task2')
  })

  it('creates job tasks', () => {
    const mockJob = {
      dispatch: vi.fn().mockResolvedValue(undefined),
    }

    const schedule = new Schedule()
    schedule.job(mockJob, { data: 'test' }).daily()

    const tasks = schedule.buildTasks()
    expect(tasks).toHaveLength(1)
  })
})

describe('ScheduledTask', () => {
  it('runs callback', async () => {
    const callback = vi.fn()
    const task = new ScheduledTask({
      expression: '* * * * *',
      callback,
    })

    await task.run()
    expect(callback).toHaveBeenCalled()
  })

  it('checks isDue', () => {
    const date = new Date()
    const minute = date.getMinutes()
    const hour = date.getHours()

    const task = new ScheduledTask({
      expression: `${minute} ${hour} * * *`,
      callback: async () => {},
    })

    expect(task.isDue(date)).toBe(true)
  })

  it('runs before/after callbacks', async () => {
    const order: string[] = []

    const task = new ScheduledTask({
      expression: '* * * * *',
      callback: async () => {
        order.push('main')
      },
      before: async () => {
        order.push('before')
      },
      after: async () => {
        order.push('after')
      },
    })

    await task.run()
    expect(order).toEqual(['before', 'main', 'after'])
  })

  it('runs onSuccess callback', async () => {
    const onSuccess = vi.fn()

    const task = new ScheduledTask({
      expression: '* * * * *',
      callback: async () => {},
      onSuccess,
    })

    await task.run()
    expect(onSuccess).toHaveBeenCalled()
  })

  it('runs onFailure callback on error', async () => {
    const onFailure = vi.fn()
    const error = new Error('Test error')

    const task = new ScheduledTask({
      expression: '* * * * *',
      callback: async () => {
        throw error
      },
      onFailure,
    })

    await expect(task.run()).rejects.toThrow('Test error')
    expect(onFailure).toHaveBeenCalledWith(error)
  })

  it('respects when condition', async () => {
    const callback = vi.fn()

    const task = new ScheduledTask({
      expression: '* * * * *',
      callback,
      when: async () => false,
    })

    await task.run()
    expect(callback).not.toHaveBeenCalled()
  })

  it('respects skip condition', async () => {
    const callback = vi.fn()

    const task = new ScheduledTask({
      expression: '* * * * *',
      callback,
      skip: async () => true,
    })

    await task.run()
    expect(callback).not.toHaveBeenCalled()
  })

  it('prevents overlapping', async () => {
    const calls: number[] = []
    let resolveFirst: () => void

    const firstPromise = new Promise<void>((resolve) => {
      resolveFirst = resolve
    })

    const task = new ScheduledTask({
      expression: '* * * * *',
      callback: async () => {
        calls.push(Date.now())
        await firstPromise
      },
      withoutOverlapping: true,
    })

    // Start first run
    const run1 = task.run()

    // Try to run again while first is running
    await task.run()

    // Resolve first run
    resolveFirst!()
    await run1

    // Only one call should have happened
    expect(calls).toHaveLength(1)
  })
})

describe('Scheduler', () => {
  let scheduler: Scheduler

  beforeEach(() => {
    scheduler = new Scheduler({ checkInterval: 1000 })
  })

  it('schedules tasks', () => {
    scheduler.schedule((schedule) => {
      schedule.call(async () => {}).everyMinute().name('task1')
      schedule.call(async () => {}).hourly().name('task2')
    })

    expect(scheduler.count()).toBe(2)
  })

  it('gets due tasks', () => {
    const date = new Date()
    const minute = date.getMinutes()
    const hour = date.getHours()

    scheduler.schedule((schedule) => {
      schedule.call(async () => {}).cron(`${minute} ${hour} * * *`).name('due')
      schedule.call(async () => {}).cron(`${(minute + 1) % 60} ${hour} * * *`).name('not-due')
    })

    const dueTasks = scheduler.getDueTasks(date)
    expect(dueTasks).toHaveLength(1)
    expect(dueTasks[0].getName()).toBe('due')
  })

  it('runs due tasks', async () => {
    const callback = vi.fn()
    const date = new Date()
    const minute = date.getMinutes()
    const hour = date.getHours()

    scheduler.schedule((schedule) => {
      schedule.call(callback).cron(`${minute} ${hour} * * *`)
    })

    await scheduler.runDueTasks(date)
    expect(callback).toHaveBeenCalled()
  })

  it('starts and stops', () => {
    scheduler.schedule((schedule) => {
      schedule.call(async () => {}).everyMinute()
    })

    scheduler.start()
    expect(scheduler.getIsRunning()).toBe(true)

    scheduler.stop()
    expect(scheduler.getIsRunning()).toBe(false)
  })

  it('gets task by name', () => {
    scheduler.schedule((schedule) => {
      schedule.call(async () => {}).everyMinute().name('my-task')
    })

    const task = scheduler.getTask('my-task')
    expect(task).toBeDefined()
    expect(task?.getName()).toBe('my-task')
  })

  it('removes task by name', () => {
    scheduler.schedule((schedule) => {
      schedule.call(async () => {}).everyMinute().name('my-task')
    })

    expect(scheduler.removeTask('my-task')).toBe(true)
    expect(scheduler.count()).toBe(0)
  })

  it('clears all tasks', () => {
    scheduler.schedule((schedule) => {
      schedule.call(async () => {}).everyMinute()
      schedule.call(async () => {}).hourly()
    })

    scheduler.clear()
    expect(scheduler.count()).toBe(0)
  })

  describe('createScheduler', () => {
    it('creates a scheduler', () => {
      const s = createScheduler({ checkInterval: 5000 })
      expect(s.getCheckInterval()).toBe(5000)
    })
  })
})
