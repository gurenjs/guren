import { describe, expect, it } from 'bun:test'

import { PENDING_JOIN_WINDOW_MS, PendingComputations } from '../../src/cache/pending-computations'

describe('PendingComputations', () => {
  it('joins a computation that started within the window', async () => {
    let clock = 1_000
    const pending = new PendingComputations(() => clock)
    const held = Promise.withResolvers<{ id: number }>()
    let computed = 0
    const compute = () => {
      computed += 1
      return held.promise
    }

    const first = pending.run('key', 60, compute)
    clock += PENDING_JOIN_WINDOW_MS - 1
    const second = pending.run('key', 60, compute)
    held.resolve({ id: 1 })

    expect(computed).toBe(1)
    expect(await second).toBe(await first)
  })

  it('starts a new computation once the running one is as old as the window', async () => {
    let clock = 1_000
    const pending = new PendingComputations(() => clock)
    const hung = Promise.withResolvers<string>()
    const replacement = Promise.withResolvers<string>()
    const started: string[] = []

    const stuck = pending.run('key', 60, () => {
      started.push('hung')
      return hung.promise
    })
    clock += PENDING_JOIN_WINDOW_MS
    const fresh = pending.run('key', 60, () => {
      started.push('replacement')
      return replacement.promise
    })

    hung.resolve('late')
    expect(await stuck).toBe('late')

    // The hung computation settling must not evict the one that replaced it.
    clock += 1
    const joined = pending.run('key', 60, () => {
      started.push('third')
      return Promise.resolve('unused')
    })
    replacement.resolve('fresh')

    expect(await fresh).toBe('fresh')
    expect(await joined).toBe('fresh')
    expect(started).toEqual(['hung', 'replacement'])
  })

  // The cache guide states this number.
  it('uses a ten-second window', () => {
    expect(PENDING_JOIN_WINDOW_MS).toBe(10_000)
  })

  it('does not share between different TTLs of one key', async () => {
    const pending = new PendingComputations()
    const held = Promise.withResolvers<string>()

    const forever = pending.run('key', undefined, () => held.promise)
    const minute = pending.run('key', 60, async () => 'minute')
    held.resolve('forever')

    expect(await minute).toBe('minute')
    expect(await forever).toBe('forever')
  })

  it('turns a synchronous throw into a rejection and lets the next call retry', async () => {
    const pending = new PendingComputations()
    const failure = new Error('thrown before any await')

    await expect(
      pending.run('key', 60, () => {
        throw failure
      }),
    ).rejects.toBe(failure)
    expect(await pending.run('key', 60, async () => 'retried')).toBe('retried')
  })

  it('starts a new computation for every TTL after the key is forgotten', async () => {
    const pending = new PendingComputations()
    const minute = Promise.withResolvers<string>()
    const forever = Promise.withResolvers<string>()

    const first = [pending.run('key', 60, () => minute.promise), pending.run('key', undefined, () => forever.promise)]
    pending.forget('key')
    const second = [pending.run('key', 60, async () => 'minute again'), pending.run('key', undefined, async () => 'forever again')]
    minute.resolve('minute')
    forever.resolve('forever')

    expect(await Promise.all(second)).toEqual(['minute again', 'forever again'])
    expect(await Promise.all(first)).toEqual(['minute', 'forever'])
  })
})
