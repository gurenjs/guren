import { describe, expect, it } from 'bun:test'
import { CacheManager } from '../../src/cache/CacheManager'
import { RedisStore } from '../../src/cache/stores/RedisStore'

/**
 * Records every command so a test can assert on the *shape* of an operation,
 * not just its result: the counter methods must be one round trip, because a
 * read-then-write preamble is where two concurrent callers lose an increment.
 */
class RecordingRedis {
  readonly commands: Array<[string, ...unknown[]]> = []
  private readonly data = new Map<string, string>()

  async exists(...keys: string[]): Promise<number> {
    this.commands.push(['exists', ...keys])
    return keys.filter((k) => this.data.has(k)).length
  }

  async set(key: string, value: string): Promise<'OK'> {
    this.commands.push(['set', key, value])
    this.data.set(key, value)
    return 'OK'
  }

  async incrby(key: string, by: number): Promise<number> {
    this.commands.push(['incrby', key, by])
    const next = Number(this.data.get(key) ?? '0') + by
    this.data.set(key, String(next))
    return next
  }

  async decrby(key: string, by: number): Promise<number> {
    this.commands.push(['decrby', key, by])
    const next = Number(this.data.get(key) ?? '0') - by
    this.data.set(key, String(next))
    return next
  }
}

const createStore = () => {
  const redis = new RecordingRedis()
  return { redis, store: new RedisStore({ client: redis }) }
}

describe('RedisStore counters', () => {
  it('increments a missing key with a single INCRBY', async () => {
    const { redis, store } = createStore()

    expect(await store.increment('hits', 3)).toBe(3)
    expect(redis.commands).toEqual([['incrby', 'cache:hits', 3]])
  })

  it('decrements a missing key with a single DECRBY', async () => {
    const { redis, store } = createStore()

    expect(await store.decrement('hits')).toBe(-1)
    expect(redis.commands).toEqual([['decrby', 'cache:hits', 1]])
  })

  it('continues from the stored value', async () => {
    const { store } = createStore()
    await store.set('hits', 5)

    expect(await store.increment('hits')).toBe(6)
    expect(await store.decrement('hits', 4)).toBe(2)
  })
})

describe('RedisStore client factory', () => {
  it('calls a client function and uses what it returns', async () => {
    const redis = new RecordingRedis()
    const store = new RedisStore({ client: () => redis })

    expect(await store.increment('hits')).toBe(1)
    expect(redis.commands).toEqual([['incrby', 'cache:hits', 1]])
  })

  it('refuses a client factory that returns a Promise, naming the cause', () => {
    expect(() => new RedisStore({ client: async () => new RecordingRedis() })).toThrow(
      '`client` returned a Promise',
    )
  })

  it('leaves a declared but unselected redis store unbuilt', () => {
    let built = 0
    const manager = new CacheManager({
      default: 'memory',
      stores: {
        memory: { driver: 'memory', checkPeriod: 0 },
        redis: { driver: 'redis', client: () => { built += 1; return new RecordingRedis() } },
      },
    })

    manager.store()
    expect(built).toBe(0)

    manager.store('redis')
    manager.store('redis')
    expect(built).toBe(1)
  })
})
