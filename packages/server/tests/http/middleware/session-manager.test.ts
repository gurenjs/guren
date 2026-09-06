import { describe, expect, it } from 'bun:test'
import { MemorySessionStore, type SessionStore } from '../../../src/http/middleware/session'
import { SessionManager, type SessionDriverFactory } from '../../../src/http/middleware/session-manager'

/** Enough of ioredis for RedisSessionStore's read/write/destroy/touch. */
function fakeRedis() {
  const data = new Map<string, string>()
  return {
    calls: [] as string[],
    async get(key: string) { this.calls.push(`get ${key}`); return data.get(key) ?? null },
    async setex(key: string, _ttl: number, value: string) { this.calls.push(`setex ${key}`); data.set(key, value) },
    async del(key: string) { this.calls.push(`del ${key}`); data.delete(key) },
    async expire(key: string) { this.calls.push(`expire ${key}`) },
  }
}

describe('SessionManager', () => {
  it('should default to an implied memory store when nothing is declared', () => {
    const manager = new SessionManager()

    expect(manager.getDefaultStoreName()).toBe('memory')
    expect(manager.storeNames()).toEqual(['memory'])
    expect(manager.store()).toBeInstanceOf(MemorySessionStore)
  })

  it('should refuse an undeclared default at construction, naming the declared stores', () => {
    expect(() => new SessionManager({ default: 'databse', stores: { database: { driver: 'memory' } } })).toThrow(
      'Session store "databse" is not declared. Declare it under `stores` or use one of: database.',
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
      stores: { redis: { driver: 'redis', client: () => { built += 1; return fakeRedis() } }, memory: { driver: 'memory' } },
    })

    expect(built).toBe(0)
    manager.store()
    expect(built).toBe(1)
    manager.store()
    expect(built).toBe(1)
  })

  it('should pass the redis client and prefix through to RedisSessionStore', async () => {
    const redis = fakeRedis()
    const manager = new SessionManager({
      default: 'redis',
      stores: { redis: { driver: 'redis', client: redis, prefix: 'sess:' } },
    })

    await manager.store().write('abc', { user: 1 }, 60)
    expect(await manager.store().read('abc')).toEqual({ user: 1 })
    expect(redis.calls).toEqual(['setex sess:abc', 'get sess:abc'])
  })

  it('should resolve a driver registered after construction, so plugin order does not matter', () => {
    const manager = new SessionManager({
      default: 'dynamodb',
      stores: { dynamodb: { driver: 'dynamodb', table: 'sessions' } as never },
    })

    expect(() => manager.store()).toThrow('Unknown session driver "dynamodb" for store "dynamodb"')

    const built: unknown[] = []
    const factory: SessionDriverFactory = (options, context) => {
      built.push({ options, context })
      return new MemorySessionStore()
    }
    manager.registerDriver('dynamodb', factory)

    expect(manager.store()).toBeInstanceOf(MemorySessionStore)
    expect(built).toEqual([{ options: { table: 'sessions' }, context: { ttlSeconds: 7200, cookieName: 'guren.session' } }])
  })

  it('should hand a driver the configured ttl and cookie name', () => {
    const manager = new SessionManager({
      ttlSeconds: 30,
      cookieName: 'app.sid',
      default: 'custom',
      stores: { custom: { driver: 'custom' } as never },
    })
    let seen: unknown
    manager.registerDriver('custom', (_options, context) => { seen = context; return new MemorySessionStore() })

    manager.store()
    expect(seen).toEqual({ ttlSeconds: 30, cookieName: 'app.sid' })
  })

  it('should rebuild stores of a driver that gets re-registered', () => {
    const manager = new SessionManager({ stores: { memory: { driver: 'memory' } } })
    const first = manager.store()
    manager.registerDriver('memory', () => new MemorySessionStore())

    expect(manager.store()).not.toBe(first)
  })

  it('should reject an unknown store name at resolution', () => {
    const manager = new SessionManager({ stores: { memory: { driver: 'memory' } } })

    expect(() => manager.store('redis')).toThrow('Session store "redis" is not declared. Declared stores: memory.')
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

  it('should expose the cookie settings and a lazy store for the middleware', () => {
    const manager = new SessionManager({ cookieName: 'x', ttlSeconds: 5, stores: { memory: { driver: 'memory' } } })

    const options = manager.middlewareOptions()
    expect(options.cookieName).toBe('x')
    expect(options.ttlSeconds).toBe(5)
    expect(typeof options.store).toBe('function')
    expect((options.store as () => SessionStore)()).toBe(manager.store())
  })
})
