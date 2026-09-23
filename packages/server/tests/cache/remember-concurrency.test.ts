import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CacheManager } from '../../src/cache/CacheManager'
import { FileStore } from '../../src/cache/stores/FileStore'
import { MemoryStore } from '../../src/cache/stores/MemoryStore'
import { RedisStore } from '../../src/cache/stores/RedisStore'
import type { CacheStore } from '../../src/cache/types'

/** The part of ioredis RedisStore uses on these paths, with every reply a real async hop. */
class FakeRedis {
  private readonly data = new Map<string, { value: string; seconds: number }>()

  async get(key: string): Promise<string | null> {
    return this.data.get(key)?.value ?? null
  }

  async set(key: string, value: string, mode?: string): Promise<'OK' | null> {
    if (mode === 'NX' && this.data.has(key)) return null
    this.data.set(key, { value, seconds: -1 })
    return 'OK'
  }

  async setex(key: string, seconds: number, value: string): Promise<'OK'> {
    this.data.set(key, { value, seconds })
    return 'OK'
  }

  async del(...keys: string[]): Promise<number> {
    return keys.filter((key) => this.data.delete(key)).length
  }

  async ttl(key: string): Promise<number> {
    return this.data.get(key)?.seconds ?? -2
  }
}

/**
 * Records every `get` the store finishes, the reads inside its own `remember`
 * included. A caller decides whether to join as soon as its first read
 * finishes, so waiting for a count of reads is a barrier that the file store's
 * uneven disk timing cannot slip past.
 */
class ReadLog {
  private readonly keys: string[] = []

  constructor(store: CacheStore) {
    const read = store.get.bind(store)
    store.get = async <T,>(key: string): Promise<T | null> => {
      try {
        return await read<T>(key)
      } finally {
        this.keys.push(key)
      }
    }
  }

  async waitFor(count: number, matches: (key: string) => boolean): Promise<void> {
    const deadline = Date.now() + 2_000
    while (this.keys.filter(matches).length < count) {
      if (Date.now() > deadline) {
        throw new Error(`waited for ${count} finished reads, saw ${this.keys.filter(matches).length}`)
      }
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
}

const isKey = (name: string) => (key: string) => key === name
const isTagged = (key: string) => key.startsWith('tagged:')

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

const drivers: Array<[string, () => Promise<CacheStore>]> = [
  ['memory', async () => new MemoryStore({ checkPeriod: 0 })],
  [
    'file',
    async () => {
      const path = await mkdtemp(join(tmpdir(), 'guren-remember-'))
      cleanups.push(() => rm(path, { recursive: true, force: true }))
      return new FileStore({ path })
    },
  ],
  ['redis', async () => new RedisStore({ client: new FakeRedis() })],
]

const memoryAt = (now: () => number) => async () => new MemoryStore({ checkPeriod: 0, now })

async function managerFor(createStore: () => Promise<CacheStore>): Promise<{ cache: CacheManager; reads: ReadLog }> {
  const store = await createStore()
  const reads = new ReadLog(store)
  const cache = new CacheManager({ default: 'main' })
  cache.registerStore('main', () => store)
  return { cache, reads }
}

describe.each(drivers)('remember on the %s store', (_name, createStore) => {
  it('runs the callback once for concurrent misses and hands every caller the same object', async () => {
    const { cache, reads } = await managerFor(createStore)
    const release = Promise.withResolvers<void>()
    let calls = 0
    const callback = async () => {
      calls += 1
      await release.promise
      return { id: 1 }
    }

    const callers = Array.from({ length: 5 }, () => cache.store().remember('posts', 60, callback))
    // Each caller's own read, and the one inside the computation they share.
    await reads.waitFor(6, isKey('posts'))
    release.resolve()
    const results = await Promise.all(callers)

    expect(calls).toBe(1)
    for (const result of results) expect(result).toBe(results[0])
    expect(await cache.store().get<{ id: number }>('posts')).toEqual({ id: 1 })
  })

  it('shares one callback between concurrent rememberForever calls', async () => {
    const { cache, reads } = await managerFor(createStore)
    const release = Promise.withResolvers<void>()
    let calls = 0
    const callback = async () => {
      calls += 1
      await release.promise
      return ['settings']
    }

    const callers = Array.from({ length: 5 }, () => cache.store().rememberForever('settings', callback))
    await reads.waitFor(6, isKey('settings'))
    release.resolve()
    const results = await Promise.all(callers)

    expect(calls).toBe(1)
    for (const result of results) expect(result).toBe(results[0])
    expect(await cache.store().ttl('settings')).toBe(-1)
  })

  it('hands every concurrent caller the same error, then lets the next call retry', async () => {
    const { cache, reads } = await managerFor(createStore)
    const release = Promise.withResolvers<void>()
    const failure = new Error('database unavailable')
    let calls = 0
    const failing = async (): Promise<string> => {
      calls += 1
      await release.promise
      throw failure
    }

    const callers = Array.from({ length: 5 }, () => cache.store().remember('report', 60, failing))
    await reads.waitFor(6, isKey('report'))
    release.resolve()
    const settled = await Promise.allSettled(callers)

    expect(calls).toBe(1)
    for (const outcome of settled) {
      expect(outcome.status).toBe('rejected')
      expect((outcome as PromiseRejectedResult).reason).toBe(failure)
    }

    expect(await cache.store().remember('report', 60, async () => 'recovered')).toBe('recovered')
    expect(await cache.store().get<string>('report')).toBe('recovered')
  })

  it('keeps different keys apart', async () => {
    const { cache, reads } = await managerFor(createStore)
    const release = Promise.withResolvers<void>()
    const seen: string[] = []
    const callbackFor = (key: string) => async () => {
      seen.push(key)
      await release.promise
      return key
    }

    const callers = [
      cache.store().remember('a', 60, callbackFor('a')),
      cache.store().remember('b', 60, callbackFor('b')),
      cache.store().remember('a', 60, callbackFor('a')),
    ]
    await reads.waitFor(3, isKey('a'))
    await reads.waitFor(2, isKey('b'))
    release.resolve()

    expect(await Promise.all(callers)).toEqual(['a', 'b', 'a'])
    expect(seen.sort()).toEqual(['a', 'b'])
  })

  it('shares one callback between tagged caches built for each call', async () => {
    const { cache, reads } = await managerFor(createStore)
    const release = Promise.withResolvers<void>()
    let calls = 0
    const callback = async () => {
      calls += 1
      await release.promise
      return { title: 'Hello' }
    }

    const callers = Array.from({ length: 5 }, () =>
      cache.store().tags(['posts', 'post:1']).remember('post:1', 60, callback),
    )
    await reads.waitFor(6, isTagged)
    release.resolve()
    const results = await Promise.all(callers)

    expect(calls).toBe(1)
    for (const result of results) expect(result).toBe(results[0])
    expect(await cache.store().tags(['posts', 'post:1']).get<{ title: string }>('post:1')).toEqual({ title: 'Hello' })

    await cache.store().tags(['post:1']).flush()
    expect(await cache.store().tags(['posts', 'post:1']).get('post:1')).toBeNull()
  })
})

describe.each(drivers.slice(1))('remember hits on the %s store', (_name, createStore) => {
  // The memory store hands out the stored object itself; these two decode a copy per read.
  it('hands each concurrent hit its own copy, as get does', async () => {
    const { cache } = await managerFor(createStore)
    await cache.store().set('posts', { id: 1 })
    const callback = async () => ({ id: 2 })

    const results = await Promise.all(Array.from({ length: 5 }, () => cache.store().remember('posts', 60, callback)))

    expect(results).toEqual(Array.from({ length: 5 }, () => ({ id: 1 })))
    expect(new Set(results).size).toBe(5)
  })

  it('hands each concurrent tagged hit its own copy', async () => {
    const { cache } = await managerFor(createStore)
    await cache.store().tags(['posts']).set('posts', { id: 1 })
    const callback = async () => ({ id: 2 })

    const results = await Promise.all(
      Array.from({ length: 5 }, () => cache.store().tags(['posts']).remember('posts', 60, callback)),
    )

    expect(results).toEqual(Array.from({ length: 5 }, () => ({ id: 1 })))
    expect(new Set(results).size).toBe(5)
  })
})

describe('remember across operations', () => {
  const memory = drivers[0][1]

  const scopes: Array<[string, (cache: CacheManager) => CacheStore, (key: string) => boolean]> = [
    ['store', (cache) => cache.store(), isKey('key')],
    ['tagged cache', (cache) => cache.store().tags(['posts']), isTagged],
  ]

  it.each(scopes)('runs a separate callback for a call on the %s with another TTL', async (_name, scope, isRead) => {
    const { cache, reads } = await managerFor(memoryAt(() => 1_000_000))
    const forever = Promise.withResolvers<string>()
    const minute = Promise.withResolvers<string>()
    let calls = 0

    const pendingForever = scope(cache).rememberForever('key', async () => {
      calls += 1
      return forever.promise
    })
    await reads.waitFor(2, isRead)
    const pendingMinute = scope(cache).remember('key', 60, async () => {
      calls += 1
      return minute.promise
    })
    // The minute call's own read, then the one inside its own computation.
    await reads.waitFor(4, isRead)
    forever.resolve('forever')
    expect(await pendingForever).toBe('forever')
    minute.resolve('minute')

    expect(await pendingMinute).toBe('minute')
    expect(calls).toBe(2)
    expect(await scope(cache).ttl('key')).toBe(60)
  })

  it.each(scopes)(
    'does not run the callback again for a caller on the %s whose read missed before the value was stored',
    async (_name, scope, isRead) => {
      const store = new MemoryStore({ checkPeriod: 0 })
      const cache = new CacheManager({ default: 'main' })
      cache.registerStore('main', () => store)
      const read = store.get.bind(store)
      const holding = Promise.withResolvers<void>()
      const heldRead = Promise.withResolvers<void>()
      let reads = 0
      store.get = async <T,>(key: string): Promise<T | null> => {
        const value = await read<T>(key)
        if (isRead(key) && ++reads === 1) {
          holding.resolve()
          await heldRead.promise
        }
        return value
      }
      let calls = 0
      const callback = async () => {
        calls += 1
        return { id: 1 }
      }

      // This caller has read a miss and is held before it can join anything.
      const late = scope(cache).remember('key', 60, callback)
      await holding.promise
      const first = await scope(cache).remember('key', 60, callback)
      heldRead.resolve()

      expect(await late).toEqual(first)
      expect(calls).toBe(1)
    },
  )

  it('stores a tagged result under the namespace it read, so a flush while it runs discards it', async () => {
    const { cache, reads } = await managerFor(memory)
    const held = Promise.withResolvers<string>()

    const pending = cache.store().tags(['posts']).remember('key', 60, async () => held.promise)
    // The tagged key is resolved before this read, so it names the namespace from before the flush.
    await reads.waitFor(1, isTagged)
    await cache.store().tags(['posts']).flush()
    held.resolve('from before the flush')

    expect(await pending).toBe('from before the flush')
    expect(await cache.store().tags(['posts']).get('key')).toBeNull()
  })

  // A write the next call reads back is a hit, which never reaches the join, so
  // the writes store a one-second entry that the test's clock then expires.
  const writes: Array<[string, (cache: CacheManager) => CacheStore, (cache: CacheManager) => Promise<unknown>]> = [
    ['set', (cache) => cache.store(), (cache) => cache.store().set('key', 'written', 1)],
    ['delete', (cache) => cache.store(), (cache) => cache.store().delete('key')],
    ['clear', (cache) => cache.store(), (cache) => cache.store().clear()],
    ['setMany', (cache) => cache.store(), (cache) => cache.store().setMany(new Map([['key', 'written']]), 1)],
    ['deleteMany', (cache) => cache.store(), (cache) => cache.store().deleteMany(['key'])],
    ['a tagged set', (cache) => cache.store().tags(['posts']), (cache) => cache.store().tags(['posts']).set('key', 'written', 1)],
    ['a tagged delete', (cache) => cache.store().tags(['posts']), (cache) => cache.store().tags(['posts']).delete('key')],
  ]

  it.each(writes)('does not join a callback that started before %s', async (_name, scope, write) => {
    let clock = 1_000_000
    const { cache, reads } = await managerFor(memoryAt(() => clock))
    const isRead = (key: string) => key === 'key' || isTagged(key)
    const first = Promise.withResolvers<string>()

    const before = scope(cache).remember('key', 60, async () => first.promise)
    await reads.waitFor(1, isRead)
    await write(cache)
    clock += 2_000
    const after = scope(cache).remember('key', 60, async () => 'fresh')
    // The first call's two reads, then the later call's own: it has joined or started by now.
    await reads.waitFor(3, isRead)
    first.resolve('stale')

    expect(await after).toBe('fresh')
    expect(await before).toBe('stale')
  })

  it('still treats a cached null as a miss', async () => {
    const { cache } = await managerFor(memory)
    let calls = 0
    const callback = async () => {
      calls += 1
      return null
    }

    expect(await cache.store().remember('nothing', 60, callback)).toBeNull()
    expect(await cache.store().remember('nothing', 60, callback)).toBeNull()
    expect(calls).toBe(2)
  })
})
