import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MemoryStore,
  FileStore,
  TaggedCache,
  CacheManager,
  createCacheManager,
} from '../../src/cache'

describe('MemoryStore', () => {
  let store: MemoryStore
  let currentTime: number

  beforeEach(() => {
    currentTime = 1_000_000
    store = new MemoryStore({ checkPeriod: 0, now: () => currentTime })
  })

  afterEach(() => {
    store.destroy()
  })

  describe('get/set', () => {
    it('stores and retrieves a value', async () => {
      await store.set('key', 'value')
      expect(await store.get('key')).toBe('value')
    })

    it('returns null for missing key', async () => {
      expect(await store.get('missing')).toBeNull()
    })

    it('stores objects', async () => {
      const obj = { name: 'John', age: 30 }
      await store.set('user', obj)
      expect(await store.get('user')).toEqual(obj)
    })

    it('stores arrays', async () => {
      const arr = [1, 2, 3]
      await store.set('numbers', arr)
      expect(await store.get('numbers')).toEqual(arr)
    })
  })

  describe('TTL', () => {
    it('expires items after TTL', async () => {
      await store.set('key', 'value', 1)
      expect(await store.get('key')).toBe('value')

      currentTime += 1100
      expect(await store.get('key')).toBeNull()
    })

    it('returns correct TTL', async () => {
      await store.set('key', 'value', 10)
      expect(await store.ttl('key')).toBe(10)
    })

    it('returns -1 for items without TTL', async () => {
      await store.set('key', 'value')
      expect(await store.ttl('key')).toBe(-1)
    })

    it('returns -2 for missing keys', async () => {
      expect(await store.ttl('missing')).toBe(-2)
    })
  })

  describe('has', () => {
    it('returns true for existing key', async () => {
      await store.set('key', 'value')
      expect(await store.has('key')).toBe(true)
    })

    it('returns false for missing key', async () => {
      expect(await store.has('missing')).toBe(false)
    })

    it('returns false for expired key', async () => {
      await store.set('key', 'value', 1)
      expect(await store.has('key')).toBe(true)
      currentTime += 1100
      expect(await store.has('key')).toBe(false)
    })
  })

  describe('delete', () => {
    it('deletes an existing key', async () => {
      await store.set('key', 'value')
      expect(await store.delete('key')).toBe(true)
      expect(await store.get('key')).toBeNull()
    })

    it('returns false for missing key', async () => {
      expect(await store.delete('missing')).toBe(false)
    })
  })

  describe('clear', () => {
    it('removes all items', async () => {
      await store.set('key1', 'value1')
      await store.set('key2', 'value2')
      await store.clear()
      expect(await store.get('key1')).toBeNull()
      expect(await store.get('key2')).toBeNull()
    })
  })

  describe('increment/decrement', () => {
    it('increments a value', async () => {
      await store.set('counter', 5)
      expect(await store.increment('counter')).toBe(6)
      expect(await store.increment('counter', 3)).toBe(9)
    })

    it('initializes to 0 if key does not exist', async () => {
      expect(await store.increment('new')).toBe(1)
    })

    it('decrements a value', async () => {
      await store.set('counter', 10)
      expect(await store.decrement('counter')).toBe(9)
      expect(await store.decrement('counter', 4)).toBe(5)
    })

    it('preserves TTL on increment', async () => {
      await store.set('counter', 5, 10)
      await store.increment('counter')
      expect(await store.ttl('counter')).toBe(10)
    })
  })

  describe('remember', () => {
    it('returns cached value if exists', async () => {
      await store.set('key', 'cached')
      let callbackCalled = false

      const result = await store.remember('key', 60, async () => {
        callbackCalled = true
        return 'new value'
      })

      expect(result).toBe('cached')
      expect(callbackCalled).toBe(false)
    })

    it('calls callback and caches if not exists', async () => {
      let callbackCalled = false

      const result = await store.remember('key', 60, async () => {
        callbackCalled = true
        return 'computed'
      })

      expect(result).toBe('computed')
      expect(callbackCalled).toBe(true)
      expect(await store.get('key')).toBe('computed')
    })
  })

  describe('rememberForever', () => {
    it('caches value without TTL', async () => {
      const result = await store.rememberForever('key', async () => 'value')
      expect(result).toBe('value')
      expect(await store.ttl('key')).toBe(-1)
    })
  })

  describe('getMany/setMany', () => {
    it('gets multiple values', async () => {
      await store.set('key1', 'value1')
      await store.set('key2', 'value2')

      const result = await store.getMany<string>(['key1', 'key2', 'key3'])
      expect(result.get('key1')).toBe('value1')
      expect(result.get('key2')).toBe('value2')
      expect(result.get('key3')).toBeNull()
    })

    it('sets multiple values', async () => {
      await store.setMany(
        new Map([
          ['key1', 'value1'],
          ['key2', 'value2'],
        ])
      )

      expect(await store.get('key1')).toBe('value1')
      expect(await store.get('key2')).toBe('value2')
    })
  })

  describe('deleteMany', () => {
    it('deletes multiple keys', async () => {
      await store.set('key1', 'value1')
      await store.set('key2', 'value2')
      await store.set('key3', 'value3')

      const deleted = await store.deleteMany(['key1', 'key2', 'missing'])
      expect(deleted).toBe(2)
      expect(await store.get('key1')).toBeNull()
      expect(await store.get('key2')).toBeNull()
      expect(await store.get('key3')).toBe('value3')
    })
  })

  describe('maxSize', () => {
    it('evicts oldest item when full', async () => {
      const limitedStore = new MemoryStore({ maxSize: 2, checkPeriod: 0 })

      await limitedStore.set('key1', 'value1')
      await limitedStore.set('key2', 'value2')
      await limitedStore.set('key3', 'value3')

      expect(await limitedStore.get('key1')).toBeNull()
      expect(await limitedStore.get('key2')).toBe('value2')
      expect(await limitedStore.get('key3')).toBe('value3')

      limitedStore.destroy()
    })
  })
})

describe('FileStore', () => {
  let store: FileStore
  let tmpDir: string
  let currentTime: number

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'guren-cache-'))
    currentTime = 1_000_000
    store = new FileStore({ path: tmpDir, now: () => currentTime })
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  describe('get/set', () => {
    it('stores and retrieves a value', async () => {
      await store.set('key', 'value')
      expect(await store.get('key')).toBe('value')
    })

    it('returns null for missing key', async () => {
      expect(await store.get('missing')).toBeNull()
    })

    it('stores objects', async () => {
      const obj = { name: 'John', age: 30 }
      await store.set('user', obj)
      expect(await store.get('user')).toEqual(obj)
    })

    it('persists across instances', async () => {
      await store.set('key', 'value')

      const newStore = new FileStore({ path: tmpDir })
      expect(await newStore.get('key')).toBe('value')
    })
  })

  describe('TTL', () => {
    it('expires items after TTL', async () => {
      await store.set('key', 'value', 1)
      expect(await store.get('key')).toBe('value')

      currentTime += 1100
      expect(await store.get('key')).toBeNull()
    })
  })

  describe('delete', () => {
    it('deletes an existing key', async () => {
      await store.set('key', 'value')
      expect(await store.delete('key')).toBe(true)
      expect(await store.get('key')).toBeNull()
    })
  })

  describe('clear', () => {
    it('removes all items', async () => {
      await store.set('key1', 'value1')
      await store.set('key2', 'value2')
      await store.clear()
      expect(await store.get('key1')).toBeNull()
      expect(await store.get('key2')).toBeNull()
    })
  })

  describe('cleanup', () => {
    it('removes expired files', async () => {
      await store.set('key1', 'value1', 1)
      await store.set('key2', 'value2')

      currentTime += 1100

      const cleaned = await store.cleanup()
      expect(cleaned).toBe(1)
      expect(await store.cleanup()).toBe(0)
      expect(await store.get('key2')).toBe('value2')
    })
  })
})

describe('TaggedCache', () => {
  let store: MemoryStore
  let tagged: TaggedCache

  beforeEach(() => {
    store = new MemoryStore({ checkPeriod: 0 })
    tagged = new TaggedCache(store, ['posts', 'user:1'])
  })

  afterEach(() => {
    store.destroy()
  })

  describe('get/set', () => {
    it('stores and retrieves a value', async () => {
      await tagged.set('key', 'value')
      expect(await tagged.get('key')).toBe('value')
    })

    it('returns null for missing key', async () => {
      expect(await tagged.get('missing')).toBeNull()
    })
  })

  describe('flush', () => {
    it('removes all items with tags', async () => {
      await tagged.set('key1', 'value1')
      await tagged.set('key2', 'value2')

      await tagged.flush()

      expect(await tagged.get('key1')).toBeNull()
      expect(await tagged.get('key2')).toBeNull()
    })

    it('does not affect items with different tags', async () => {
      const otherTagged = new TaggedCache(store, ['comments'])
      await otherTagged.set('comment', 'text')

      await tagged.set('post', 'content')
      await tagged.flush()

      expect(await tagged.get('post')).toBeNull()
      expect(await otherTagged.get('comment')).toBe('text')
    })
  })

  describe('getTags', () => {
    it('returns the tags', () => {
      expect(tagged.getTags()).toEqual(['posts', 'user:1'])
    })
  })
})

describe('CacheManager', () => {
  let manager: CacheManager

  beforeEach(() => {
    manager = new CacheManager({
      default: 'memory',
      stores: {
        memory: { driver: 'memory' },
      },
    })
  })

  describe('store', () => {
    it('returns the default store', async () => {
      const store = manager.store()
      await store.set('key', 'value')
      expect(await store.get('key')).toBe('value')
    })

    it('returns a named store', async () => {
      const store = manager.store('memory')
      await store.set('key', 'value')
      expect(await store.get('key')).toBe('value')
    })

    it('throws for unknown store', () => {
      expect(() => manager.store('unknown')).toThrow('Cache store not found: unknown')
    })

    it('caches resolved stores', () => {
      const store1 = manager.store()
      const store2 = manager.store()
      expect(store1).toBe(store2)
    })
  })

  describe('tags', () => {
    it('returns a tagged cache', async () => {
      const tagged = manager.store().tags(['posts'])
      await tagged.set('key', 'value')
      expect(await tagged.get('key')).toBe('value')

      await tagged.flush()
      expect(await tagged.get('key')).toBeNull()
    })
  })

  describe('registerStore', () => {
    it('registers a custom store', async () => {
      manager.registerStore('custom', () => new MemoryStore({ checkPeriod: 0 }))

      const store = manager.store('custom')
      await store.set('key', 'value')
      expect(await store.get('key')).toBe('value')
    })
  })

  describe('hasStore', () => {
    it('returns true for registered stores', () => {
      expect(manager.hasStore('memory')).toBe(true)
    })

    it('returns false for unregistered stores', () => {
      expect(manager.hasStore('unknown')).toBe(false)
    })
  })

  describe('getStoreNames', () => {
    it('returns all registered store names', () => {
      expect(manager.getStoreNames()).toContain('memory')
    })
  })

  describe('createCacheManager', () => {
    it('creates a manager with default config', async () => {
      const mgr = createCacheManager()
      const store = mgr.store()
      await store.set('key', 'value')
      expect(await store.get('key')).toBe('value')
    })
  })
})
