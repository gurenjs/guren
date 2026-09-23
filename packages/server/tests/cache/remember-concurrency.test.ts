import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CacheManager } from '../../src/cache/CacheManager'
import type { StoreConfig } from '../../src/cache/types'

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

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
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
    const release = deferred()
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
    const release = deferred()
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
    const release = deferred()
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
    const release = deferred()
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
    const release = deferred()
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

describe('remember across operations', () => {
  const memory = drivers[0][1]

  it('shares one callback between remember and rememberForever on the same key', async () => {
    const cache = await managerFor(memory)
    const release = deferred()
    let calls = 0
    const callback = async () => {
      calls += 1
      await release.promise
      return 'value'
    }

    const callers = [
      cache.store().remember('key', 60, callback),
      cache.store().rememberForever('key', callback),
    ]
    await letCallersRun()
    release.resolve()

    expect(await Promise.all(callers)).toEqual(['value', 'value'])
    expect(calls).toBe(1)
  })

  it('does not join a callback that started before the key was deleted', async () => {
    const cache = await managerFor(memory)
    const first = deferred<string>()
    const calls: string[] = []

    const before = cache.store().remember('key', 60, async () => {
      calls.push('before')
      return first.promise
    })
    await letCallersRun()
    await cache.store().delete('key')
    const after = cache.store().remember('key', 60, async () => {
      calls.push('after')
      return 'fresh'
    })

    expect(await settledOrWaiting(after)).toBe('fresh')
    first.resolve('stale')
    expect(await before).toBe('stale')
    expect(calls).toEqual(['before', 'after'])
  })

  it('does not join a tagged callback that started before the key was set', async () => {
    const cache = await managerFor(memory)
    const first = deferred<string>()

    const before = cache.store().tags(['posts']).remember('key', 60, async () => first.promise)
    await letCallersRun()
    await cache.store().tags(['posts']).set('key', 'written')
    const after = cache.store().tags(['posts']).remember('key', 60, async () => 'unused')

    expect(await settledOrWaiting(after)).toBe('written')
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
