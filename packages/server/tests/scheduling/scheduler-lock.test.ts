import { describe, it, expect, beforeEach } from 'bun:test'
import { MemorySchedulerLock, ScheduledTask, Scheduler, type SchedulerLock } from '../../src/scheduling'
import { RedisSchedulerLock } from '../../src/redis/RedisSchedulerLock'
import { resetWarnOnce } from '../../src/support/warn-once'

const MINUTE = 60_000

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** Every task is due every minute; `at` is fixed so two ticks in a row land on distinct keys. */
function tick(minutes: number): Date {
  return new Date(Date.UTC(2026, 0, 1, 0, minutes))
}

describe('ScheduledTask overlap guard', () => {
  it('skips a run while the previous one is still running', async () => {
    const gate = deferred()
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
    const hung = deferred()
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
    const staleGate = deferred()
    const successorGate = deferred()
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

describe('Scheduler.runDueTasks', () => {
  beforeEach(() => {
    resetWarnOnce()
  })

  it('runs due tasks concurrently, so a slow task does not hold back the rest', async () => {
    const slow = deferred()
    const fastDone = deferred()
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
    const warnings: string[] = []
    const warn = console.warn
    console.warn = (message: string) => warnings.push(message)
    let runs = 0

    try {
      const scheduler = new Scheduler()
      scheduler.schedule((schedule) => {
        schedule
          .call(async () => {
            runs += 1
          })
          .everyMinute()
          .name('report')
          .runOnOneServer()
      })

      await scheduler.runDueTasks(tick(0))
      await scheduler.runDueTasks(tick(0))
    } finally {
      console.warn = warn
    }

    expect(runs).toBe(1)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('createScheduler({ lock })')
    expect(warnings[0]).toContain('RedisSchedulerLock')
  })

  it('refuses an unnamed or empty-named runOnOneServer() task, since the lock is keyed on the name', async () => {
    const unnamed = new Scheduler({ lock: new MemorySchedulerLock() })
    unnamed.schedule((schedule) => {
      schedule.call(async () => {}).everyMinute().runOnOneServer()
    })
    await expect(unnamed.runDueTasks(tick(0))).rejects.toThrow('without a name')

    const blank = new Scheduler({ lock: new MemorySchedulerLock() })
    blank.schedule((schedule) => {
      schedule.call(async () => {}).everyMinute().name('').runOnOneServer()
    })
    await expect(blank.runDueTasks(tick(0))).rejects.toThrow('without a name')
    expect(() => blank.start()).toThrow('without a name')
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
    const scheduler = new Scheduler({ lock, logger: (message) => log.push(message) })
    scheduler.schedule((schedule) => {
      schedule
        .call(async () => {
          runs += 1
        })
        .everyMinute()
        .name('report')
        .runOnOneServer()
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
    const scheduler = new Scheduler({ lock, logger: (message) => log.push(message) })
    scheduler.schedule((schedule) => {
      schedule.call(async () => {}).everyMinute().name('report').runOnOneServer().skip(() => true)
    })

    await scheduler.runDueTasks(tick(0))

    expect(log).toContain('Lock release failed: report - redis down')
    expect(log.some((line) => line.startsWith('Task failed'))).toBe(false)
  })

  it('reports a task whose callback throws instead of swallowing it in allSettled', async () => {
    const log: string[] = []
    const scheduler = new Scheduler({ logger: (message) => log.push(message) })
    scheduler.schedule((schedule) => {
      schedule
        .call(async () => {
          throw new Error('boom')
        })
        .everyMinute()
        .name('report')
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
    const scheduler = new Scheduler({ lock, lockPrefix: 'billing:' })
    scheduler.schedule((schedule) => {
      schedule.call(async () => {}).everyMinute().name('report').runOnOneServer()
    })

    await scheduler.runDueTasks(tick(0))

    expect(claimed).toEqual([`billing:report:${tick(0).getTime() / MINUTE}`])
  })

  it('runs a runOnOneServer() task on the one server that wins the tick', async () => {
    const lock = new MemorySchedulerLock()
    const runs: string[] = []
    const server = (id: string): Scheduler => {
      const scheduler = new Scheduler({ lock })
      scheduler.schedule((schedule) => {
        schedule
          .call(async () => {
            runs.push(id)
          })
          .everyMinute()
          .name('report')
          .runOnOneServer()
      })
      return scheduler
    }

    const a = server('a')
    const b = server('b')

    await Promise.all([a.runDueTasks(tick(0)), b.runDueTasks(tick(0))])
    expect(runs).toEqual(['a'])

    // The next minute is a new claim; a finished run does not release the old one.
    await b.runDueTasks(tick(1))
    await a.runDueTasks(tick(1))
    expect(runs).toEqual(['a', 'b'])
  })

  it('gives the tick back when the winning server declines to run it', async () => {
    const released: string[] = []
    const lock: SchedulerLock = {
      acquire: async () => true,
      release: async (key) => {
        released.push(key)
      },
    }
    const scheduler = new Scheduler({ lock })
    scheduler.schedule((schedule) => {
      schedule
        .call(async () => {})
        .everyMinute()
        .name('report')
        .runOnOneServer()
        .skip(() => true)
    })

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

  it('drops expired keys on acquire, so a per-minute key does not grow the map forever', async () => {
    let now = 0
    const lock = new MemorySchedulerLock(() => now)
    const held = (lock as unknown as { held: Map<string, number> }).held

    for (let minute = 0; minute < 10; minute += 1) {
      now = minute * 60_000
      expect(await lock.acquire(`schedule:report:${minute}`, 60)).toBe(true)
    }

    // Without the sweep this is 10: one key per minute, none of them released.
    expect(held.size).toBe(1)
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
