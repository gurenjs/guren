import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { getNextRunTime, listScheduledTasks, runScheduledTasks } from '../src/schedule'

describe('schedule', () => {
  const testDir = resolve(import.meta.dir, '.test-schedule')
  const kernelDir = join(testDir, 'app/Console')
  const kernelPath = join(kernelDir, 'Kernel.ts')

  beforeEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true })
    }
    mkdirSync(kernelDir, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true })
    }
  })

  describe('listScheduledTasks', () => {
    test('shows message when no kernel file exists', async () => {
      await listScheduledTasks({ appRoot: testDir })
    })

    test('loads tasks from kernel file', async () => {
      const kernelContent = `
export class Schedule {
  private tasks = []

  call(callback) {
    const pending = {
      expression: '* * * * *',
      name: 'test-task',
      daily() {
        this.expression = '0 0 * * *'
        return this
      },
      name(n) {
        this.taskName = n
        return this
      },
      toTask() {
        return {
          name: this.taskName || 'unnamed',
          expression: this.expression,
        }
      }
    }
    this.tasks.push(pending)
    return pending
  }

  buildTasks() {
    return this.tasks.map(t => t.toTask())
  }
}

export function scheduleTasksKernel() {
  const schedule = new Schedule()
  schedule.call(() => {}).daily().name('daily-task')
  return schedule
}
`
      writeFileSync(kernelPath, kernelContent)

      await listScheduledTasks({ appRoot: testDir })
    })
  })

  describe('runScheduledTasks', () => {
    test('shows message when no kernel file exists', async () => {
      await runScheduledTasks({ appRoot: testDir })
    })

    test('can filter by task name', async () => {
      const kernelContent = `
export class Schedule {
  private tasks = []

  call(callback) {
    const pending = {
      expression: '* * * * *',
      taskName: null,
      daily() {
        this.expression = '0 0 * * *'
        return this
      },
      name(n) {
        this.taskName = n
        return this
      },
      toTask() {
        return {
          name: this.taskName || 'unnamed',
          expression: this.expression,
        }
      }
    }
    this.tasks.push(pending)
    return pending
  }

  buildTasks() {
    return this.tasks.map(t => t.toTask())
  }
}

export function scheduleTasksKernel() {
  const schedule = new Schedule()
  schedule.call(() => {}).daily().name('task-1')
  schedule.call(() => {}).daily().name('task-2')
  return schedule
}
`
      writeFileSync(kernelPath, kernelContent)

      await runScheduledTasks({ appRoot: testDir, task: 'task-1' })
    })

    test('can force run tasks', async () => {
      const kernelContent = `
export class Schedule {
  private tasks = []

  call(callback) {
    const pending = {
      expression: '* * * * *',
      taskName: null,
      daily() {
        this.expression = '0 0 * * *'
        return this
      },
      name(n) {
        this.taskName = n
        return this
      },
      toTask() {
        return {
          name: this.taskName || 'unnamed',
          expression: this.expression,
        }
      }
    }
    this.tasks.push(pending)
    return pending
  }

  buildTasks() {
    return this.tasks.map(t => t.toTask())
  }
}

export function scheduleTasksKernel() {
  const schedule = new Schedule()
  schedule.call(() => {}).daily().name('forced-task')
  return schedule
}
`
      writeFileSync(kernelPath, kernelContent)

      await runScheduledTasks({ appRoot: testDir, force: true })
    })
  })
})

describe('getNextRunTime', () => {
  const wallClock = (instant: Date, timeZone: string): string =>
    new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false })
      .format(instant)

  test('honors the task timezone rather than the process local time', () => {
    // 12:00Z is 21:00 in Tokyo and 08:00 in New York (EDT); the next 03:00
    // wall clock lands on different instants, so no single TZ satisfies both.
    const from = new Date('2026-06-10T12:00:00Z')

    const tokyo = getNextRunTime('0 3 * * *', 'Asia/Tokyo', from)
    expect(tokyo?.toISOString()).toBe('2026-06-10T18:00:00.000Z')
    expect(wallClock(tokyo!, 'Asia/Tokyo')).toBe('03:00')

    const newYork = getNextRunTime('0 3 * * *', 'America/New_York', from)
    expect(newYork?.toISOString()).toBe('2026-06-11T07:00:00.000Z')
    expect(wallClock(newYork!, 'America/New_York')).toBe('03:00')
  })

  test('returns null for a timezone Intl does not know', () => {
    expect(getNextRunTime('0 3 * * *', 'Mars/Olympus_Mons', new Date('2026-06-10T12:00:00Z'))).toBeNull()
  })

  test('"* 3 * * *" runs every minute of the 3 o\'clock hour', () => {
    expect(getNextRunTime('* 3 * * *', undefined, new Date(2026, 5, 10, 12, 0, 0)))
      .toEqual(new Date(2026, 5, 11, 3, 0, 0))
    expect(getNextRunTime('* 3 * * *', undefined, new Date(2026, 5, 10, 3, 15, 30)))
      .toEqual(new Date(2026, 5, 10, 3, 16, 0))
    expect(getNextRunTime('* 3 * * *', undefined, new Date(2026, 5, 10, 3, 59, 0)))
      .toEqual(new Date(2026, 5, 11, 3, 0, 0))
  })

  test('"0 3 * * *" runs once a day at 03:00 local time', () => {
    expect(getNextRunTime('0 3 * * *', undefined, new Date(2026, 5, 10, 12, 0, 0)))
      .toEqual(new Date(2026, 5, 11, 3, 0, 0))
    expect(getNextRunTime('0 3 * * *', undefined, new Date(2026, 5, 10, 2, 59, 0)))
      .toEqual(new Date(2026, 5, 10, 3, 0, 0))
    expect(getNextRunTime('0 3 * * *', undefined, new Date(2026, 5, 10, 3, 0, 0)))
      .toEqual(new Date(2026, 5, 11, 3, 0, 0))
  })

  test('honors the day fields the old estimator ignored', () => {
    // 2026-06-10 is a Wednesday; the next Monday is the 15th.
    expect(getNextRunTime('30 9 * * 1', undefined, new Date(2026, 5, 10, 12, 0, 0)))
      .toEqual(new Date(2026, 5, 15, 9, 30, 0))
    expect(getNextRunTime('0 0 1 * *', undefined, new Date(2026, 5, 10, 12, 0, 0)))
      .toEqual(new Date(2026, 6, 1, 0, 0, 0))
  })

  test('returns null for an expression that cannot match', () => {
    expect(getNextRunTime('0 25 * * *', undefined, new Date(2026, 5, 10))).toBeNull()
    expect(getNextRunTime('not a cron', undefined, new Date(2026, 5, 10))).toBeNull()
  })
})
