import { describe, it, expect, beforeEach } from 'bun:test'
import {
  MemorySchedulerLock,
  ScheduledTask,
  Scheduler,
  type SchedulerLock,
  type SchedulerOptions,
} from '../../src/scheduling'
import { RedisSchedulerLock } from '../../src/redis/RedisSchedulerLock'
import { resetWarnOnce } from '../../src/support/warn-once'
import { captureWarnings } from '../support/warnings'

const MINUTE = 60_000

/** Every task is due every minute; `at` is fixed so two ticks in a row land on distinct keys. */
function tick(minutes: number): Date {
  return new Date(Date.UTC(2026, 0, 1, 0, minutes))
}

describe('ScheduledTask overlap guard', () => {
  it('skips a run while the previous one is still running', async () => {
    const gate = Promise.withResolvers<void>()
    let runs = 0
    const task = new ScheduledTask({
      expression: '* * * * *',
      withoutOverlapping: true,
      callback: async () => {
        runs += 1
        await gate.promise
      },
    })

    const first = task.tryRun(tick(0))
    expect(await task.tryRun(tick(1))).toBe(false)
    expect(runs).toBe(1)

    gate.resolve()
    expect(await first).toBe(true)
    expect(await task.tryRun(tick(2))).toBe(true)
    expect(runs).toBe(2)
  })

  it('lets the next run through once overlapExpiresAt has passed', async () => {
    const hung = Promise.withResolvers<void>()
    let runs = 0
    const task = new ScheduledTask({
      expression: '* * * * *',
      withoutOverlapping: true,
      overlapExpiresAt: 10 * MINUTE,
      callback: async () => {
        runs += 1
        if (runs === 1) await hung.promise
      },
    })

    void task.tryRun(tick(0))
    expect(await task.tryRun(tick(9))).toBe(false)
    expect(await task.tryRun(tick(10))).toBe(true)
    expect(runs).toBe(2)

    hung.resolve()
  })

  it('keeps the successor guarded when the run it replaced finally finishes', async () => {
    const staleGate = Promise.withResolvers<void>()
    const successorGate = Promise.withResolvers<void>()
    const pending = [staleGate, successorGate]
    const task = new ScheduledTask({
      expression: '* * * * *',
      withoutOverlapping: true,
      overlapExpiresAt: 10 * MINUTE,
      callback: async () => {
        await pending.shift()!.promise
      },
    })

    const stale = task.tryRun(tick(0))
    const successor = task.tryRun(tick(10))
    expect(await task.tryRun(tick(11))).toBe(false)

    staleGate.resolve()
    expect(await stale).toBe(true)
    expect(await task.tryRun(tick(12))).toBe(false)

    successorGate.resolve()
    expect(await successor).toBe(true)
    expect(task.isCurrentlyRunning()).toBe(false)
  })

  it('releases the guard when when() rejects, rather than pinning the task forever', async () => {
    let failNext = true
    let runs = 0
    const task = new ScheduledTask({
      expression: '* * * * *',
      withoutOverlapping: true,
      when: () => {
        if (failNext) throw new Error('probe unavailable')
        return true
      },
      callback: async () => {
        runs += 1
      },
    })

    await expect(task.tryRun(tick(0))).rejects.toThrow('probe unavailable')
    expect(task.isCurrentlyRunning()).toBe(false)

    failNext = false
    expect(await task.tryRun(tick(1))).toBe(true)
    expect(runs).toBe(1)
  })

  it('run() resolves to undefined whether or not the callback ran', async () => {
    const task = new ScheduledTask({
      expression: '* * * * *',
      skip: () => true,
      callback: async () => {},
    })

    expect(await task.run(tick(0))).toBeUndefined()
  })
})

interface ReportSchedulerOptions extends SchedulerOptions {
  callback?: () => Promise<void>
  skip?: () => boolean
  /** @default true */
  onOneServer?: boolean
}

/** The fixture these tests share: one task named `report`, due every minute. */
function reportScheduler({
  callback = async () => {},
  skip,
  onOneServer = true,
  ...options
}: ReportSchedulerOptions = {}): Scheduler {
  const scheduler = new Scheduler(options)
  scheduler.schedule((schedule) => {
    const task = schedule.call(callback).everyMinute().name('report')
    if (onOneServer) task.runOnOneServer()
    if (skip) task.skip(skip)
  })
  return scheduler
}

describe('Scheduler.runDueTasks', () => {
  beforeEach(() => {
    resetWarnOnce()
  })

  it('runs due tasks concurrently, so a slow task does not hold back the rest', async () => {
    const slow = Promise.withResolvers<void>()
    const fastDone = Promise.withResolvers<void>()
    const order: string[] = []
    const scheduler = new Scheduler()
    scheduler.schedule((schedule) => {
      schedule
        .call(async () => {
          order.push('slow:start')
          await slow.promise
          order.push('slow:end')
        })
        .everyMinute()
        .name('slow')
      schedule
        .call(async () => {
          order.push('fast')
          fastDone.resolve()
        })
        .everyMinute()
        .name('fast')
    })

    const running = scheduler.runDueTasks(tick(0))
    await fastDone.promise
    expect(order).toEqual(['slow:start', 'fast'])

    slow.resolve()
    await running
    expect(order).toEqual(['slow:start', 'fast', 'slow:end'])
  })

  it('runs a runOnOneServer() task on the default in-process lock, warning that it spans one process', async () => {
    let runs = 0

    const warnings = await captureWarnings(async () => {
      const scheduler = reportScheduler({ callback: async () => { runs += 1 } })
      await scheduler.runDueTasks(tick(0))
      await scheduler.runDueTasks(tick(0))
    })

    expect(runs).toBe(1)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('createScheduler({ lock })')
    expect(warnings[0]).toContain('RedisSchedulerLock')
  })

  it('refuses an unnamed or empty-named runOnOneServer() task, since the lock is keyed on the name', () => {
    const unnamed = new Scheduler({ lock: new MemorySchedulerLock() })
    expect(() =>
      unnamed.schedule((schedule) => {
        schedule.call(async () => {}).everyMinute().runOnOneServer()
      }),
    ).toThrow('without a name')

    // Refused where it is registered, so a tick never pays for the check. The
    // definer has run by then, so the task is on the list either way.
    const blank = new Scheduler({ lock: new MemorySchedulerLock() })
    expect(() =>
      blank.schedule((schedule) => {
        schedule.call(async () => {}).everyMinute().name('').runOnOneServer()
      }),
    ).toThrow('without a name')
    expect(() => blank.start()).toThrow('without a name')
  })

  it('refuses an unnamed runOnOneServer() task handed to addTask()', () => {
    const scheduler = new Scheduler({ lock: new MemorySchedulerLock() })

    expect(() =>
      scheduler.addTask(new ScheduledTask({ expression: '* * * * *', onOneServer: true, callback: async () => {} })),
    ).toThrow('without a name')
  })

  it('reports a rejecting acquire as a lock failure and does not run the task', async () => {
    const log: string[] = []
    let runs = 0
    const lock: SchedulerLock = {
      acquire: async () => {
        throw new Error('redis down')
      },
      release: async () => {},
    }
    const scheduler = reportScheduler({
      lock,
      logger: (message) => log.push(message),
      callback: async () => { runs += 1 },
    })

    await scheduler.runDueTasks(tick(0))

    expect(runs).toBe(0)
    expect(log).toEqual(['Lock failed: report - redis down'])
  })

  it('reports a rejecting release without calling it a task failure', async () => {
    const log: string[] = []
    const lock: SchedulerLock = {
      acquire: async () => true,
      release: async () => {
        throw new Error('redis down')
      },
    }
    const scheduler = reportScheduler({ lock, logger: (message) => log.push(message), skip: () => true })

    await scheduler.runDueTasks(tick(0))

    expect(log).toContain('Lock release failed: report - redis down')
    expect(log.some((line) => line.startsWith('Task failed'))).toBe(false)
  })

  it('reports a task whose callback throws instead of swallowing it in allSettled', async () => {
    const log: string[] = []
    const scheduler = reportScheduler({
      logger: (message) => log.push(message),
      onOneServer: false,
      callback: async () => { throw new Error('boom') },
    })

    await scheduler.runDueTasks(tick(0))

    expect(log).toContain('Task failed: report - boom')
  })

  it('namespaces the lock key with lockPrefix, so two apps on one store do not collide', async () => {
    const claimed: string[] = []
    const lock: SchedulerLock = {
      acquire: async (key) => {
        claimed.push(key)
        return true
      },
      release: async () => {},
    }
    const scheduler = reportScheduler({ lock, lockPrefix: 'billing:' })

    await scheduler.runDueTasks(tick(0))

    expect(claimed).toEqual([`billing:report:${tick(0).getTime() / MINUTE}`])
  })

  it('runs a runOnOneServer() task on the one server that wins the tick', async () => {
    const lock = new MemorySchedulerLock()
    const runs: string[] = []
    const server = (id: string): Scheduler => reportScheduler({ lock, callback: async () => { runs.push(id) } })

    const a = server('a')
    const b = server('b')

    await Promise.all([a.runDueTasks(tick(0)), b.runDueTasks(tick(0))])
    expect(runs).toEqual(['a'])

    // The next minute is a new claim; a finished run does not release the old one.
    await b.runDueTasks(tick(1))
    await a.runDueTasks(tick(1))
    expect(runs).toEqual(['a', 'b'])
  })

  it('does not claim the tick for a task its own overlap guard already refuses', async () => {
    const claimed: string[] = []
    const lock: SchedulerLock = {
      acquire: async (key) => {
        claimed.push(key)
        return true
      },
      release: async () => {},
    }
    const gate = Promise.withResolvers<void>()
    const task = new ScheduledTask({
      expression: '* * * * *',
      name: 'report',
      onOneServer: true,
      withoutOverlapping: true,
      callback: async () => {
        await gate.promise
      },
    })
    const running = task.tryRun(tick(0))

    const scheduler = new Scheduler({ lock })
    scheduler.addTask(task)
    await scheduler.runDueTasks(tick(1))

    expect(claimed).toEqual([])

    gate.resolve()
    expect(await running).toBe(true)
  })

  it('gives the tick back when the winning server declines to run it', async () => {
    const released: string[] = []
    const lock: SchedulerLock = {
      acquire: async () => true,
      release: async (key) => {
        released.push(key)
      },
    }
    const scheduler = reportScheduler({ lock, skip: () => true })

    await scheduler.runDueTasks(tick(0))
    expect(released).toEqual([`schedule:report:${tick(0).getTime() / MINUTE}`])
  })
})

describe('MemorySchedulerLock', () => {
  it('holds a key until its ttl passes or it is released', async () => {
    let now = 0
    const lock = new MemorySchedulerLock(() => now)

    expect(await lock.acquire('a', 60)).toBe(true)
    expect(await lock.acquire('a', 60)).toBe(false)
    expect(await lock.acquire('b', 60)).toBe(true)

    now = 59_999
    expect(await lock.acquire('a', 60)).toBe(false)
    now = 60_000
    expect(await lock.acquire('a', 60)).toBe(true)

    await lock.release('b')
    expect(await lock.acquire('b', 60)).toBe(true)
  })

  it('drops expired keys once the map grows, so a per-minute key does not grow it forever', async () => {
    let now = 0
    const lock = new MemorySchedulerLock(() => now)
    const held = (lock as unknown as { held: Map<string, number> }).held

    for (let minute = 0; minute < 200; minute += 1) {
      now = minute * 60_000
      expect(await lock.acquire(`schedule:report:${minute}`, 60)).toBe(true)
    }

    // Without the sweep this is 200: one key per minute, none of them released.
    expect(held.size).toBeLessThanOrEqual(64)
    // And above 1, or the sweep is running on every acquire rather than on growth.
    expect(held.size).toBeGreaterThan(1)
  })
})

describe('RedisSchedulerLock', () => {
  it('claims with SET NX EX and reads OK as the win', async () => {
    const calls: unknown[][] = []
    let reply: 'OK' | null = 'OK'
    const redis = {
      set: async (...args: unknown[]) => {
        calls.push(args)
        return reply
      },
      del: async (...args: unknown[]) => {
        calls.push(['del', ...args])
        return 1
      },
    }
    const lock = new RedisSchedulerLock(redis as never, { prefix: 'locks:' })

    expect(await lock.acquire('schedule:report:1', 3600)).toBe(true)
    reply = null
    expect(await lock.acquire('schedule:report:1', 3600)).toBe(false)
    await lock.release('schedule:report:1')

    expect(calls).toEqual([
      ['locks:schedule:report:1', '1', 'EX', 3600, 'NX'],
      ['locks:schedule:report:1', '1', 'EX', 3600, 'NX'],
      ['del', 'locks:schedule:report:1'],
    ])
  })
})
