import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { consola } from 'consola'
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

describe('schedule kernel discovery', () => {
  const root = resolve(import.meta.dir, '.test-schedule-discovery')

  // A fresh directory per test: `import()` caches by URL, so a second kernel
  // written to a path already loaded in this process is never read.
  let fixtures = 0
  let testDir: string
  let kernelPath: string

  // Kept apart so the `--json` test can assert on stdout alone; every other
  // assertion reads both.
  let stdout: string[] = []
  let stderr: string[] = []

  const original = {
    info: consola.info, warn: consola.warn, error: consola.error, success: consola.success,
    log: console.log,
  }

  beforeEach(() => {
    fixtures += 1
    testDir = join(root, `app-${fixtures}`)
    kernelPath = join(testDir, 'app/Console/Kernel.ts')
    mkdirSync(join(testDir, 'app/Console'), { recursive: true })
    stdout = []
    stderr = []
    const record = (into: string[]) => (...args: unknown[]) => { into.push(args.map(String).join(' ')) }
    Object.assign(consola, {
      info: record(stderr), warn: record(stderr), error: record(stderr), success: record(stderr),
    })
    console.log = record(stdout) as typeof console.log
    // Bun ignores `process.exitCode = undefined`, and a leaked 1 here would
    // fail the whole test run, not just the assertion.
    process.exitCode = 0
  })

  afterEach(() => {
    Object.assign(consola, original)
    console.log = original.log
    process.exitCode = 0
    rmSync(root, { recursive: true, force: true })
  })

  const listed = (): string => [...stdout, ...stderr].join('\n')

  test('discovers a registrar taking the scheduler, the shape apps bind in a provider', async () => {
    writeFileSync(kernelPath, `
export function registerAppSchedules(scheduler) {
  scheduler.schedule((schedule) => {
    schedule.call(() => {}).hourly().name('app:warm-cache')
  })
}
`)

    await listScheduledTasks({ appRoot: testDir })

    expect(listed()).toContain('app:warm-cache')
    expect(listed()).toContain('Total: 1 task')
    expect(process.exitCode).toBe(0)
  })

  test('counts a registrar exported twice once', async () => {
    writeFileSync(kernelPath, `
export function registerAppSchedules(scheduler) {
  scheduler.schedule((schedule) => {
    schedule.call(() => {}).hourly().name('app:warm-cache')
  })
}
export default registerAppSchedules
`)

    await listScheduledTasks({ appRoot: testDir })

    expect(listed()).toContain('Total: 1 task')
  })

  test('leaves a one-argument export alone unless its name says it is a registrar', async () => {
    writeFileSync(kernelPath, `
export function registerAppSchedules(scheduler) {
  scheduler.schedule((schedule) => {
    schedule.call(() => {}).hourly().name('app:warm-cache')
  })
}
export function summarize(row) {
  return row.missing.field
}
`)

    await listScheduledTasks({ appRoot: testDir })

    expect(listed()).not.toContain('summarize')
    expect(listed()).toContain('app:warm-cache')
  })

  test('reports a registrar the naming convention misses rather than staying silent', async () => {
    writeFileSync(kernelPath, `
export function scheduleTasks(scheduler) {
  scheduler.schedule((schedule) => {
    schedule.call(() => {}).hourly().name('app:warm-cache')
  })
}
`)

    await listScheduledTasks({ appRoot: testDir })

    expect(listed()).toContain('exports nothing the scheduler recognizes')
    expect(listed()).toContain('Found: scheduleTasks')
    expect(listed()).toContain('register…Schedules')
    expect(process.exitCode).toBe(1)
  })

  test('awaits an async registrar, so tasks added after an await are seen', async () => {
    writeFileSync(kernelPath, `
export async function registerAppSchedules(scheduler) {
  await Promise.resolve()
  scheduler.schedule((schedule) => {
    schedule.call(() => {}).hourly().name('app:late-task')
  })
}
`)

    await listScheduledTasks({ appRoot: testDir })

    expect(listed()).toContain('app:late-task')
  })

  test('reports an async registrar that rejects rather than leaving it unhandled', async () => {
    writeFileSync(kernelPath, `
export async function registerAppSchedules(scheduler) {
  await Promise.resolve()
  throw new Error('async registrar failed')
}
`)

    await listScheduledTasks({ appRoot: testDir })

    expect(listed()).toContain('registerAppSchedules(scheduler) threw')
    expect(listed()).toContain('async registrar failed')
    expect(process.exitCode).toBe(1)
  })

  test('runs a registrar-declared task', async () => {
    const marker = join(testDir, 'ran.txt')
    writeFileSync(kernelPath, `
import { writeFileSync } from 'node:fs'

export function registerAppSchedules(scheduler) {
  scheduler.schedule((schedule) => {
    schedule.call(() => { writeFileSync(${JSON.stringify(marker)}, 'ran') }).hourly().name('app:warm-cache')
  })
}
`)

    await runScheduledTasks({ appRoot: testDir, force: true })

    expect(existsSync(marker)).toBe(true)
  })

  test('names the kernel that exports nothing it recognizes, rather than the missing-kernel hint', async () => {
    writeFileSync(kernelPath, 'export const commands = []\n')

    await listScheduledTasks({ appRoot: testDir })

    expect(listed()).toContain('exports nothing the scheduler recognizes')
    expect(listed()).toContain('Kernel.ts')
    expect(listed()).toContain('Found: commands')
    expect(listed()).not.toContain('create a kernel file at')
    expect(process.exitCode).toBe(1)
  })

  test('reports a kernel that throws instead of swallowing it into debug output', async () => {
    writeFileSync(kernelPath, "throw new Error('kernel exploded')\n")

    await listScheduledTasks({ appRoot: testDir })

    expect(listed()).toContain('Failed to load the schedule kernel')
    expect(listed()).toContain('kernel exploded')
    expect(process.exitCode).toBe(1)
  })

  test('keeps the create-a-kernel hint for an app with no kernel file', async () => {
    rmSync(kernelPath, { force: true })

    await listScheduledTasks({ appRoot: testDir })

    expect(listed()).toContain('To define scheduled tasks, create a kernel file at:')
    expect(process.exitCode).toBe(0)
  })

  test('names an explicit --kernel path that does not exist', async () => {
    await listScheduledTasks({ appRoot: testDir, kernel: 'app/Console/Missing.ts' })

    expect(listed()).toContain('No schedule kernel at')
    expect(listed()).toContain('Missing.ts')
    expect(listed()).not.toContain('create a kernel file at')
    expect(process.exitCode).toBe(1)
  })

  test('keeps --json stdout parseable when the kernel is unusable', async () => {
    writeFileSync(kernelPath, 'export const commands = []\n')

    await listScheduledTasks({ appRoot: testDir, json: true })

    expect(JSON.parse(stdout.join('\n'))).toEqual([])
    expect(stderr.join('\n')).toContain('exports nothing the scheduler recognizes')
  })
})
