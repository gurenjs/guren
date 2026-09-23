import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CacheManager } from '../../src/cache/CacheManager'
import type { CacheStore, StoreConfig } from '../../src/cache/types'

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

// Lets every caller reach its callback before a test releases the first one.
// The file store reads the disk, so one microtask flush is not enough there.
async function letCallersRun(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

// A caller that joined a held computation would never settle; report it instead of hanging.
async function settledOrWaiting<T>(promise: Promise<T>): Promise<T | 'still waiting'> {
  return Promise.race([promise, letCallersRun().then(() => 'still waiting' as const)])
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

const drivers: Array<[string, () => Promise<StoreConfig>]> = [
  ['memory', async () => ({ driver: 'memory', checkPeriod: 0 })],
  [
    'file',
    async () => {
      const path = await mkdtemp(join(tmpdir(), 'guren-remember-'))
      cleanups.push(() => rm(path, { recursive: true, force: true }))
      return { driver: 'file', path }
    },
  ],
  ['redis', async () => ({ driver: 'redis', client: new FakeRedis() })],
]

async function managerFor(config: () => Promise<StoreConfig>): Promise<CacheManager> {
  return new CacheManager({ default: 'main', stores: { main: await config() } })
}

describe.each(drivers)('remember on the %s store', (_name, config) => {
  it('runs the callback once for concurrent misses and hands every caller the same object', async () => {
    const cache = await managerFor(config)
    const release = Promise.withResolvers<void>()
    let calls = 0
    const callback = async () => {
      calls += 1
      await release.promise
      return { id: 1 }
    }

    const callers = Array.from({ length: 5 }, () => cache.store().remember('posts', 60, callback))
    await letCallersRun()
    release.resolve()
    const results = await Promise.all(callers)

    expect(calls).toBe(1)
    for (const result of results) expect(result).toBe(results[0])
    expect(await cache.store().get<{ id: number }>('posts')).toEqual({ id: 1 })
  })

  it('shares one callback between concurrent rememberForever calls', async () => {
    const cache = await managerFor(config)
    const release = Promise.withResolvers<void>()
    let calls = 0
    const callback = async () => {
      calls += 1
      await release.promise
      return ['settings']
    }

    const callers = Array.from({ length: 5 }, () => cache.store().rememberForever('settings', callback))
    await letCallersRun()
    release.resolve()
    const results = await Promise.all(callers)

    expect(calls).toBe(1)
    for (const result of results) expect(result).toBe(results[0])
    expect(await cache.store().ttl('settings')).toBe(-1)
  })

  it('hands every concurrent caller the same error, then lets the next call retry', async () => {
    const cache = await managerFor(config)
    const release = Promise.withResolvers<void>()
    const failure = new Error('database unavailable')
    let calls = 0
    const failing = async (): Promise<string> => {
      calls += 1
      await release.promise
      throw failure
    }

    const callers = Array.from({ length: 5 }, () => cache.store().remember('report', 60, failing))
    await letCallersRun()
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
    const cache = await managerFor(config)
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
    await letCallersRun()
    release.resolve()

    expect(await Promise.all(callers)).toEqual(['a', 'b', 'a'])
    expect(seen.sort()).toEqual(['a', 'b'])
  })

  it('shares one callback between tagged caches built for each call', async () => {
    const cache = await managerFor(config)
    const release = Promise.withResolvers<void>()
    let calls = 0
    const callback = async () => {
      calls += 1
      await release.promise
      return { title: 'Hello' }
    }

    // Creating a namespace takes the file store's lock, whose retry sleeps, so
    // a cold one would let some callers arrive after the computation finished.
    await cache.store().tags(['posts', 'post:1']).get('post:1')
    const callers = Array.from({ length: 5 }, () =>
      cache.store().tags(['posts', 'post:1']).remember('post:1', 60, callback),
    )
    await letCallersRun()
    release.resolve()
    const results = await Promise.all(callers)

    expect(calls).toBe(1)
    for (const result of results) expect(result).toBe(results[0])
    expect(await cache.store().tags(['posts', 'post:1']).get<{ title: string }>('post:1')).toEqual({ title: 'Hello' })

    await cache.store().tags(['post:1']).flush()
    expect(await cache.store().tags(['posts', 'post:1']).get('post:1')).toBeNull()
  })
})

describe.each(drivers.slice(1))('remember hits on the %s store', (_name, config) => {
  // The memory store hands out the stored object itself; these two decode a copy per read.
  it('hands each concurrent hit its own copy, as get does', async () => {
    const cache = await managerFor(config)
    await cache.store().set('posts', { id: 1 })
    const callback = async () => ({ id: 2 })

    const results = await Promise.all(Array.from({ length: 5 }, () => cache.store().remember('posts', 60, callback)))

    expect(results).toEqual(Array.from({ length: 5 }, () => ({ id: 1 })))
    expect(new Set(results).size).toBe(5)
  })

  it('hands each concurrent tagged hit its own copy', async () => {
    const cache = await managerFor(config)
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

  const scopes: Array<[string, (cache: CacheManager) => CacheStore]> = [
    ['store', (cache) => cache.store()],
    ['tagged cache', (cache) => cache.store().tags(['posts'])],
  ]

  it.each(scopes)('runs a separate callback for a call on the %s with another TTL', async (_name, scope) => {
    let clock = 1_000_000
    const cache = new CacheManager({ stores: { memory: { driver: 'memory', checkPeriod: 0, now: () => clock } } })
    const forever = Promise.withResolvers<string>()
    const minute = Promise.withResolvers<string>()
    let calls = 0

    const pendingForever = scope(cache).rememberForever('key', async () => {
      calls += 1
      return forever.promise
    })
    await letCallersRun()
    const pendingMinute = scope(cache).remember('key', 60, async () => {
      calls += 1
      return minute.promise
    })
    await letCallersRun()
    forever.resolve('forever')
    expect(await pendingForever).toBe('forever')
    minute.resolve('minute')

    expect(await pendingMinute).toBe('minute')
    expect(calls).toBe(2)
    expect(await scope(cache).ttl('key')).toBe(60)
  })

  it('stores a tagged result under the namespace it read, so a flush while it runs discards it', async () => {
    const cache = await managerFor(memory)
    const held = Promise.withResolvers<string>()

    const pending = cache.store().tags(['posts']).remember('key', 60, async () => held.promise)
    await letCallersRun()
    await cache.store().tags(['posts']).flush()
    held.resolve('from before the flush')

    expect(await pending).toBe('from before the flush')
    expect(await cache.store().tags(['posts']).get('key')).toBeNull()
  })

  type Remember = (cache: CacheManager, callback: () => Promise<string>) => Promise<string>
  const plain: Remember = (cache, callback) => cache.store().remember('key', 60, callback)
  const tagged: Remember = (cache, callback) => cache.store().tags(['posts']).remember('key', 60, callback)

  // A write the next call reads back is a hit, which never reaches the join, so
  // the writes store a one-second entry that the test's clock then expires.
  const writes: Array<[string, Remember, (cache: CacheManager) => Promise<unknown>]> = [
    ['set', plain, (cache) => cache.store().set('key', 'written', 1)],
    ['delete', plain, (cache) => cache.store().delete('key')],
    ['clear', plain, (cache) => cache.store().clear()],
    ['setMany', plain, (cache) => cache.store().setMany(new Map([['key', 'written']]), 1)],
    ['deleteMany', plain, (cache) => cache.store().deleteMany(['key'])],
    ['a tagged set', tagged, (cache) => cache.store().tags(['posts']).set('key', 'written', 1)],
    ['a tagged delete', tagged, (cache) => cache.store().tags(['posts']).delete('key')],
  ]

  it.each(writes)('does not join a callback that started before %s', async (_name, remember, write) => {
    let clock = 1_000_000
    const cache = new CacheManager({ stores: { memory: { driver: 'memory', checkPeriod: 0, now: () => clock } } })
    const first = Promise.withResolvers<string>()

    const before = remember(cache, async () => first.promise)
    await letCallersRun()
    await write(cache)
    clock += 2_000
    const after = remember(cache, async () => 'fresh')

    expect(await settledOrWaiting(after)).toBe('fresh')
    first.resolve('stale')
    expect(await before).toBe('stale')
  })

  it('still treats a cached null as a miss', async () => {
    const cache = await managerFor(memory)
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
