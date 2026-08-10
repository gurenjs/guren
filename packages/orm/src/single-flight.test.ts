import { describe, test, expect } from 'bun:test'
import { singleFlight } from './single-flight'

const deferred = <T,>() => Promise.withResolvers<T>()

describe('singleFlight', () => {
  test('should share one in-flight promise between concurrent callers', async () => {
    let calls = 0
    const gate = deferred<string>()
    const flight = singleFlight(() => {
      calls += 1
      return gate.promise
    })

    const first = flight.get()
    const second = flight.get()

    expect(calls).toBe(1)
    expect(first).toBe(second)

    gate.resolve('db')
    expect(await Promise.all([first, second])).toEqual(['db', 'db'])
    expect(calls).toBe(1)
  })

  test('should keep the resolved result memoized for later callers', async () => {
    let calls = 0
    const flight = singleFlight(async () => {
      calls += 1
      return calls
    })

    expect(await flight.get()).toBe(1)
    expect(await flight.get()).toBe(1)
    expect(calls).toBe(1)
  })

  test('should retry after a rejection instead of memoizing the failure', async () => {
    let calls = 0
    const flight = singleFlight(async () => {
      calls += 1
      if (calls === 1) throw new Error('connection refused')
      return 'connected'
    })

    await expect(flight.get()).rejects.toThrow('connection refused')
    expect(await flight.get()).toBe('connected')
    expect(calls).toBe(2)
  })

  test('should reject every concurrent caller of a failed attempt, then retry once', async () => {
    let calls = 0
    const gate = deferred<string>()
    const flight = singleFlight(() => {
      calls += 1
      return calls === 1 ? gate.promise : Promise.resolve('connected')
    })

    const first = flight.get()
    const second = flight.get()
    gate.reject(new Error('connection refused'))

    await expect(first).rejects.toThrow('connection refused')
    await expect(second).rejects.toThrow('connection refused')
    expect(await flight.get()).toBe('connected')
    expect(calls).toBe(2)
  })

  test('should run the factory again after reset(), even when a result was memoized', async () => {
    let calls = 0
    const flight = singleFlight(async () => {
      calls += 1
      return calls
    })

    expect(await flight.get()).toBe(1)
    flight.reset()
    expect(await flight.get()).toBe(2)
  })

  test('should not evict a newer in-flight promise when a superseded attempt rejects', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    const gates = [first, second]
    let calls = 0
    const flight = singleFlight(() => gates[calls++]!.promise)

    const stale = flight.get()
    // closeDatabase()/resetDatabase() drop the handle while the first attempt
    // is still suspended.
    flight.reset()
    const fresh = flight.get()

    first.reject(new Error('stale failure'))
    await expect(stale).rejects.toThrow('stale failure')

    // The late rejection must leave the newer attempt memoized.
    expect(flight.get()).toBe(fresh)
    expect(calls).toBe(2)

    second.resolve('connected')
    expect(await fresh).toBe('connected')
  })

  // The drivers rely on this: they expose `migrateDatabase: migrations.get` and
  // `getDatabase: database.get` straight off the returned object, so `get` and
  // `reset` must not depend on a `this` binding.
  test('should keep method references usable when detached from the returned object', async () => {
    let calls = 0
    const flight = singleFlight(async () => {
      calls += 1
      return calls
    })
    const { get, reset } = flight

    expect(await get()).toBe(1)
    reset()
    expect(await get()).toBe(2)
  })
})
