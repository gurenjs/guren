import { describe, it, expect } from 'bun:test'
import { MemorySchedulerLock, ScheduledTask, Scheduler, type SchedulerLock } from '../../src/scheduling'
import { RedisSchedulerLock } from '../../src/redis/RedisSchedulerLock'

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

    const first = task.run(tick(0))
    expect(await task.run(tick(1))).toBe(false)
    expect(runs).toBe(1)

    gate.resolve()
    expect(await first).toBe(true)
    expect(await task.run(tick(2))).toBe(true)
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

    void task.run(tick(0))
    expect(await task.run(tick(9))).toBe(false)
    expect(await task.run(tick(10))).toBe(true)
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

    const stale = task.run(tick(0))
    const successor = task.run(tick(10))
    expect(await task.run(tick(11))).toBe(false)

    staleGate.resolve()
    expect(await stale).toBe(true)
    expect(await task.run(tick(12))).toBe(false)

    successorGate.resolve()
    expect(await successor).toBe(true)
    expect(task.isCurrentlyRunning()).toBe(false)
  })
})

describe('Scheduler.runDueTasks', () => {
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

  it('refuses a runOnOneServer() task without a lock, at start() and at runDueTasks()', async () => {
    const scheduler = new Scheduler()
    scheduler.schedule((schedule) => {
      schedule.call(async () => {}).everyMinute().name('report').runOnOneServer()
    })

    expect(() => scheduler.start()).toThrow(/runOnOneServer\(\).*report.*createScheduler\(\{ lock \}\)/s)
    expect(scheduler.getIsRunning()).toBe(false)
    await expect(scheduler.runDueTasks(tick(0))).rejects.toThrow('runOnOneServer()')
  })

  it('refuses an unnamed runOnOneServer() task, since the lock is keyed on the name', async () => {
    const scheduler = new Scheduler({ lock: new MemorySchedulerLock() })
    scheduler.schedule((schedule) => {
      schedule.call(async () => {}).everyMinute().runOnOneServer()
    })

    await expect(scheduler.runDueTasks(tick(0))).rejects.toThrow('without a name')
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
