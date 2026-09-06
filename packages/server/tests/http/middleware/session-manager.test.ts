import { describe, expect, it, spyOn } from 'bun:test'
import { MemorySessionStore, type SessionStore } from '../../../src/http/middleware/session'
import { SessionManager, type SessionDriverFactory } from '../../../src/http/middleware/session-manager'
import { FakeRedis } from '../../redis/fake-redis'

describe('SessionManager', () => {
  it('should default to memory, which is always declared', () => {
    const manager = new SessionManager()

    expect(manager.getStoreNames()).toEqual(['memory'])
    expect(manager.store()).toBeInstanceOf(MemorySessionStore)
  })

  it('should keep memory declared beside the stores an app adds', () => {
    const manager = new SessionManager({ default: 'redis', stores: { redis: { driver: 'redis', client: new FakeRedis() } } })

    expect(manager.getStoreNames()).toEqual(['memory', 'redis'])
    expect(manager.store('memory')).toBeInstanceOf(MemorySessionStore)
  })

  it('should refuse an undeclared default at construction, naming the declared stores', () => {
    expect(() => new SessionManager({ default: 'databse', stores: { database: { driver: 'memory' } } })).toThrow(
      'Session store not found: databse (declared: memory, database)',
    )
  })

  it('should build a store once and hand back the same instance', () => {
    const manager = new SessionManager({ stores: { memory: { driver: 'memory' } } })

    expect(manager.store()).toBe(manager.store())
    expect(manager.store('memory')).toBe(manager.store())
  })

  it('should build nothing until a store is asked for', () => {
    let built = 0
    const manager = new SessionManager({
      default: 'redis',
      stores: { redis: { driver: 'redis', client: () => { built += 1; return new FakeRedis() } } },
    })

    expect(built).toBe(0)
    manager.store()
    expect(built).toBe(1)
    manager.store()
    expect(built).toBe(1)
  })

  it('should pass the redis client and prefix through to RedisSessionStore', async () => {
    const redis = new FakeRedis()
    const setex = spyOn(redis, 'setex')
    const manager = new SessionManager({
      default: 'redis',
      stores: { redis: { driver: 'redis', client: redis, prefix: 'sess:' } },
    })

    await manager.store().write('abc', { user: 1 }, 60)
    expect(await manager.store().read('abc')).toEqual({ user: 1 })
    expect(setex.mock.calls[0].slice(0, 2)).toEqual(['sess:abc', 60])
  })

  it('should refuse a redis client factory that returns a Promise, naming the cause', () => {
    const manager = new SessionManager({
      default: 'redis',
      stores: { redis: { driver: 'redis', client: async () => new FakeRedis() } },
    })

    expect(() => manager.store()).toThrow('`client` returned a Promise')
  })

  it('should resolve a driver registered after construction, so plugin order does not matter', () => {
    const manager = new SessionManager({
      default: 'dynamodb',
      stores: { dynamodb: { driver: 'dynamodb', table: 'sessions' } as never },
    })

    expect(() => manager.store()).toThrow('Unknown session driver: dynamodb (session store "dynamodb")')

    const built: unknown[] = []
    const factory: SessionDriverFactory = (options) => {
      built.push(options)
      return new MemorySessionStore()
    }
    manager.registerDriver('dynamodb', factory)

    expect(manager.store()).toBeInstanceOf(MemorySessionStore)
    expect(built).toEqual([{ table: 'sessions' }])
  })

  it('should report a missing driver without building the store', () => {
    let built = 0
    const manager = new SessionManager({
      default: 'later',
      stores: { later: { driver: 'later' } as never, redis: { driver: 'redis', client: () => { built += 1; return new FakeRedis() } } },
    })

    expect(() => manager.assertDriverRegistered()).toThrow('Unknown session driver: later (session store "later")')
    expect(() => manager.assertDriverRegistered('redis')).not.toThrow()
    expect(built).toBe(0)

    manager.registerDriver('later', () => new MemorySessionStore())
    expect(() => manager.assertDriverRegistered()).not.toThrow()
  })

  it('should rebuild stores of a driver that gets re-registered', () => {
    const manager = new SessionManager({ stores: { memory: { driver: 'memory' } } })
    const first = manager.store()
    manager.registerDriver('memory', () => new MemorySessionStore())

    expect(manager.store()).not.toBe(first)
  })

  it('should reject an unknown store name at resolution', () => {
    const manager = new SessionManager({ stores: { memory: { driver: 'memory' } } })

    expect(() => manager.store('redis')).toThrow('Session store not found: redis (declared: memory)')
  })

  it('should prune the default and already-built stores, and leave unselected ones unbuilt', async () => {
    const pruned: string[] = []
    const prunable = (name: string): SessionStore & { deleteExpired(now?: Date): Promise<void> } => ({
      read: async () => undefined,
      write: async () => {},
      destroy: async () => {},
      deleteExpired: async () => { pruned.push(name) },
    })
    let othersBuilt = 0
    const manager = new SessionManager({
      default: 'a',
      stores: {
        a: { driver: 'p', label: 'a' } as never,
        b: { driver: 'p', label: 'b' } as never,
        c: { driver: 'q' } as never,
      },
    })
    manager.registerDriver('p', (options) => prunable((options as { label: string }).label))
    manager.registerDriver('q', () => { othersBuilt += 1; return new MemorySessionStore() })

    manager.store('b')
    await manager.pruneExpired()

    expect(pruned.sort()).toEqual(['a', 'b'])
    expect(othersBuilt).toBe(0)
  })

  it('should expose the cookie settings without the store', () => {
    const manager = new SessionManager({ cookieName: 'x', ttlSeconds: 5, default: 'memory' })

    expect(manager.options).toEqual({ cookieName: 'x', ttlSeconds: 5 })
  })
})
