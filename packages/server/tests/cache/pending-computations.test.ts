import { describe, expect, it } from 'bun:test'

import { PENDING_JOIN_WINDOW_MS, PendingComputations } from '../../src/cache/pending-computations'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('PendingComputations', () => {
  it('joins a computation that started within the window', async () => {
    let clock = 1_000
    const pending = new PendingComputations({ now: () => clock, joinWindowMs: 100 })
    const held = deferred<{ id: number }>()
    let computed = 0
    const compute = () => {
      computed += 1
      return held.promise
    }

    const first = pending.run('key', compute)
    clock += 99
    const second = pending.run('key', compute)
    held.resolve({ id: 1 })

    expect(computed).toBe(1)
    expect(await second).toBe(await first)
  })

  it('starts a new computation once the running one is older than the window', async () => {
    let clock = 1_000
    const pending = new PendingComputations({ now: () => clock, joinWindowMs: 100 })
    const hung = deferred<string>()
    const replacement = deferred<string>()
    const started: string[] = []

    const stuck = pending.run('key', () => {
      started.push('hung')
      return hung.promise
    })
    clock += 100
    const fresh = pending.run('key', () => {
      started.push('replacement')
      return replacement.promise
    })

    hung.resolve('late')
    expect(await stuck).toBe('late')

    // The hung computation settling must not evict the one that replaced it.
    clock += 1
    const joined = pending.run('key', () => {
      started.push('third')
      return Promise.resolve('unused')
    })
    replacement.resolve('fresh')

    expect(await fresh).toBe('fresh')
    expect(await joined).toBe('fresh')
    expect(started).toEqual(['hung', 'replacement'])
  })

  it('turns a synchronous throw into a rejection and lets the next call retry', async () => {
    const pending = new PendingComputations()
    const failure = new Error('thrown before any await')

    await expect(
      pending.run('key', () => {
        throw failure
      }),
    ).rejects.toBe(failure)
    expect(await pending.run('key', async () => 'retried')).toBe('retried')
  })

  it('starts a new computation after the key is forgotten', async () => {
    const pending = new PendingComputations()
    const held = deferred<string>()

    const first = pending.run('key', () => held.promise)
    pending.forget('key')
    const second = pending.run('key', async () => 'second')
    held.resolve('first')

    expect(await second).toBe('second')
    expect(await first).toBe('first')
  })

  // The cache guide states this number.
  it('stops joining ten seconds after a computation started, by default', async () => {
    let clock = 0
    const pending = new PendingComputations({ now: () => clock })
    const hung = deferred<string>()
    let computed = 0
    const compute = () => {
      computed += 1
      return hung.promise
    }

    const callers = [pending.run('key', compute)]
    clock = 9_999
    callers.push(pending.run('key', compute))
    expect(computed).toBe(1)
    clock = PENDING_JOIN_WINDOW_MS
    callers.push(pending.run('key', compute))

    expect(PENDING_JOIN_WINDOW_MS).toBe(10_000)
    expect(computed).toBe(2)
    hung.resolve('done')
    expect(await Promise.all(callers)).toEqual(['done', 'done', 'done'])
  })
})
