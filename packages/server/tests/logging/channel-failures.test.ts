import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import vm from 'node:vm'
import { Logger, LogManager } from '../../src/logging'
import type { LogChannel, LogEntry } from '../../src/logging/types'

// Every failure a channel can produce has to end at the logging error
// reporter and nowhere else. An unhandled rejection is the failure mode
// under test: bun fails the file on one, so a leak here cannot pass.

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

let reported: unknown[]
let errorSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  reported = []
  errorSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    reported.push(args[1])
  })
})

afterEach(() => {
  errorSpy.mockRestore()
})

describe('Logger with a failing channel', () => {
  it('reports a rejecting channel through the same path as a throwing one', async () => {
    const throwing: LogChannel = { log: () => { throw new Error('sync') } }
    const rejecting: LogChannel = { log: async () => { throw new Error('async') } }
    const logger = new Logger([throwing, rejecting])

    logger.info('hello')
    await flush()

    expect(reported.map((e) => (e as Error).message)).toEqual(['sync', 'async'])
  })

  it('recognises a promise from another realm as something to wait on', async () => {
    const foreign: LogChannel = {
      log: () => vm.runInNewContext('Promise.reject(new Error("foreign"))') as Promise<void>,
    }
    const logger = new Logger([foreign])

    logger.info('hello')
    await flush()

    expect(reported.map((e) => (e as Error).message)).toEqual(['foreign'])
  })
})

describe('stack channel with failing members', () => {
  function managerWith(members: Record<string, LogChannel>): LogManager {
    const manager = new LogManager({
      default: 'stack',
      channels: {
        ...Object.fromEntries(Object.keys(members).map((name) => [name, { driver: name }])),
        stack: { driver: 'stack', channels: Object.keys(members) },
      },
    })
    for (const [name, channel] of Object.entries(members)) {
      manager.registerDriver(name, () => channel)
    }
    return manager
  }

  it('calls every member and reports each failure, even when a later member throws synchronously', async () => {
    const seen: string[] = []
    const manager = managerWith({
      first: { log: async () => { seen.push('first'); throw new Error('first rejected') } },
      second: { log: () => { seen.push('second'); throw new Error('second threw') } },
      third: { log: (entry: LogEntry) => { seen.push(`third:${entry.message}`) } },
    })

    manager.info('hello')
    await flush()

    expect(seen).toEqual(['first', 'second', 'third:hello'])
    expect(reported).toHaveLength(1)
    const failure = reported[0] as AggregateError
    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure.errors.map((e: Error) => e.message).sort()).toEqual(['first rejected', 'second threw'])
  })

  it('stays synchronous when no member goes async', () => {
    const manager = managerWith({
      sync: { log: () => { throw new Error('sync only') } },
    })

    manager.info('hello')

    expect(reported.map((e) => (e as Error).message)).toEqual(['sync only'])
  })
})
