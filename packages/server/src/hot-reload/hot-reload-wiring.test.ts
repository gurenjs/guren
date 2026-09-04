/**
 * Proves the four interval owners actually register with the hot-reload
 * registry — `hot-disposables.test.ts` would keep passing while nothing on the
 * boot path ever called it. Teardowns are synchronous, so a reload is simulated
 * by building the owner twice rather than waiting on a real interval.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { CacheManager } from '../cache/CacheManager'
import { MemoryRateLimitStore, SlidingWindowRateLimitStore } from '../http/middleware/rate-limit'
import { BroadcastManager, createBroadcastManager } from '../broadcasting/BroadcastManager'
import { Scheduler } from '../scheduling/Scheduler'
import type { SSEClient } from '../broadcasting/types'
import type { TaggableCacheStore } from '../cache/types'
import { withHotRuntime } from './testing'

interface Destroyable {
  destroy?: () => void
}

/** The store a `CacheManager` wrapped, reached past its taggable wrapper. */
function rawStoreOf(store: TaggableCacheStore): Destroyable & { checkInterval?: unknown } {
  return (store as unknown as { store: Destroyable & { checkInterval?: unknown } }).store
}

function sweepTimerOf(store: TaggableCacheStore): unknown {
  return rawStoreOf(store).checkInterval
}

function cleanupTimerOf(store: MemoryRateLimitStore | SlidingWindowRateLimitStore): unknown {
  return (store as unknown as { cleanupInterval?: unknown }).cleanupInterval
}

function sseClientsOf(manager: BroadcastManager): Map<string, SSEClient> {
  return (manager as unknown as { sseClients: Map<string, SSEClient> }).sseClients
}

function addFakeClient(manager: BroadcastManager, id: string, close: () => void): void {
  sseClientsOf(manager).set(id, { id, userId: undefined, channels: new Set(), send: () => {}, close })
}

/** A client whose close() removes it from the map, as the real cleanup() does. */
function addRecordingClient(manager: BroadcastManager, id: string, closed: string[]): void {
  addFakeClient(manager, id, () => {
    sseClientsOf(manager).delete(id)
    closed.push(id)
  })
}

function registeredSlots(scope: string, target: string): string[] {
  const registry = (globalThis as Record<symbol, unknown>)[
    Symbol.for('guren.server.hotDisposables')
  ] as Map<string, unknown> | undefined

  return [...(registry?.keys() ?? [])].filter((key) => key.startsWith(`${scope}|`) && key.endsWith(`|${target}`))
}

function hasRegisteredSlot(scope: string, target: string): boolean {
  return registeredSlots(scope, target).length > 0
}

/**
 * The call site recorded in the slot an owner claimed. Asserted rather than
 * mere slot existence: a frame offset landing on a synthetic entry still yields
 * a stable key, so owners in *different* files would collapse into one slot.
 */
function callSiteOf(scope: string, target: string): string | undefined {
  return registeredSlots(scope, target)[0]?.split('|')[1]
}

describe('CacheManager hot-reload wiring', () => {
  const survivors: Destroyable[] = []

  afterEach(() => {
    // The sweep timer is unref()ed, so a survivor cannot hang the run — but it
    // would sweep during a later test.
    for (const store of survivors.splice(0)) {
      store.destroy?.()
    }
  })

  /** Builds a manager the way a reload would: same file, same config. */
  function memoryStore(name: string): TaggableCacheStore {
    return new CacheManager({ stores: { [name]: { driver: 'memory' } } }).store(name)
  }

  test('should stop the sweep timer of the store it replaces', () => {
    withHotRuntime(() => {
      const previous = memoryStore('sweep')
      expect(sweepTimerOf(previous)).not.toBeNull()

      const current = memoryStore('sweep')

      expect(sweepTimerOf(previous)).toBeNull()
      expect(sweepTimerOf(current)).not.toBeNull()
      survivors.push(rawStoreOf(current))
    })
  })

  test('should keep stores under other names sweeping', () => {
    withHotRuntime(() => {
      const kept = memoryStore('kept')
      const replaced = memoryStore('replaced')
      const current = memoryStore('replaced')

      expect(sweepTimerOf(replaced)).toBeNull()
      expect(sweepTimerOf(kept)).not.toBeNull()
      survivors.push(rawStoreOf(kept), rawStoreOf(current))
    })
  })

  test('should leave stores alone outside a hot-reloading runtime', () => {
    const previous = memoryStore('prod')
    const current = memoryStore('prod')

    expect(sweepTimerOf(previous)).not.toBeNull()
    survivors.push(rawStoreOf(previous), rawStoreOf(current))
  })

  test('should not capture a stack outside a hot-reloading runtime', () => {
    // The stack would be held for the manager's lifetime and never read.
    const manager = new CacheManager()

    expect((manager as unknown as { builtAt?: string }).builtAt).toBeUndefined()
  })
})

describe('rate limit store hot-reload wiring', () => {
  const survivors: Array<MemoryRateLimitStore | SlidingWindowRateLimitStore> = []

  afterEach(() => {
    // This interval is NOT unref()ed: a survivor would hold the test process
    // open for its full 60s period.
    for (const store of survivors.splice(0)) {
      store.destroy()
    }
  })

  test('should stop the cleanup timer of the store it replaces', () => {
    withHotRuntime(() => {
      const previous = new MemoryRateLimitStore()
      expect(cleanupTimerOf(previous)).toBeDefined()

      const current = new MemoryRateLimitStore()

      expect(cleanupTimerOf(previous)).toBeUndefined()
      expect(cleanupTimerOf(current)).toBeDefined()
      survivors.push(current)
    })
  })

  test('should not let one store flavour stop the other', () => {
    withHotRuntime(() => {
      const fixedWindow = new MemoryRateLimitStore()
      const slidingWindow = new SlidingWindowRateLimitStore()

      expect(cleanupTimerOf(fixedWindow)).toBeDefined()
      expect(cleanupTimerOf(slidingWindow)).toBeDefined()
      survivors.push(fixedWindow, slidingWindow)
    })
  })

  test('should not claim a slot when cleanup is disabled', () => {
    withHotRuntime(() => {
      const running = new MemoryRateLimitStore()
      // A store with cleanup off owns no timer, so it must not displace one
      // that does.
      new MemoryRateLimitStore(0)

      expect(cleanupTimerOf(running)).toBeDefined()
      survivors.push(running)
    })
  })

  test('should key on the file that built the store, not the implicit constructor', () => {
    withHotRuntime(() => {
      const store = new MemoryRateLimitStore()

      // No constructor declared, so the frame between BaseMemoryStore and this
      // file has no source location.
      expect(callSiteOf('rate-limit-store', 'MemoryRateLimitStore')).toEndWith('hot-reload-wiring.test.ts')
      store.destroy()
    })
  })

  test('should give up its slot when destroyed', () => {
    withHotRuntime(() => {
      const store = new SlidingWindowRateLimitStore()
      expect(hasRegisteredSlot('rate-limit-store', 'SlidingWindowRateLimitStore')).toBe(true)

      store.destroy()

      expect(hasRegisteredSlot('rate-limit-store', 'SlidingWindowRateLimitStore')).toBe(false)
    })
  })

  test('should leave stores alone outside a hot-reloading runtime', () => {
    const previous = new MemoryRateLimitStore()
    const current = new MemoryRateLimitStore()

    expect(cleanupTimerOf(previous)).toBeDefined()
    survivors.push(previous, current)
  })
})

describe('BroadcastManager hot-reload wiring', () => {
  test('should close the SSE connections of the manager it replaces', () => {
    withHotRuntime(() => {
      const closed: string[] = []
      const previous = createBroadcastManager({ default: 'replaced' })
      addRecordingClient(previous, 'sse_1', closed)

      createBroadcastManager({ default: 'replaced' })

      expect(closed).toEqual(['sse_1'])
    })
  })

  test('should close every connection, not just the first', () => {
    withHotRuntime(() => {
      const closed: string[] = []
      const previous = createBroadcastManager({ default: 'iterated' })
      addRecordingClient(previous, 'sse_1', closed)
      addRecordingClient(previous, 'sse_2', closed)
      addRecordingClient(previous, 'sse_3', closed)

      createBroadcastManager({ default: 'iterated' })

      expect(closed).toEqual(['sse_1', 'sse_2', 'sse_3'])
      expect(sseClientsOf(previous).size).toBe(0)
    })
  })

  test('should survive a connection that throws while closing', () => {
    withHotRuntime(() => {
      const closed: string[] = []
      const previous = createBroadcastManager({ default: 'throwing' })
      addFakeClient(previous, 'sse_bad', () => {
        throw new Error('stream already torn down')
      })
      addRecordingClient(previous, 'sse_good', closed)

      createBroadcastManager({ default: 'throwing' })

      expect(closed).toEqual(['sse_good'])
    })
  })

  test('should leave managers alone outside a hot-reloading runtime', () => {
    const closed: string[] = []
    const previous = createBroadcastManager({ default: 'prod' })
    addRecordingClient(previous, 'sse_1', closed)

    createBroadcastManager({ default: 'prod' })

    expect(closed).toEqual([])
  })
})

describe('Scheduler hot-reload wiring', () => {
  const survivors: Scheduler[] = []

  afterEach(() => {
    for (const scheduler of survivors.splice(0)) {
      scheduler.stop()
    }
  })

  test('should stop the scheduler it replaces', () => {
    withHotRuntime(() => {
      const previous = new Scheduler({ timezone: 'UTC' })
      previous.start()

      const current = new Scheduler({ timezone: 'UTC' })
      current.start()

      expect(previous.getIsRunning()).toBe(false)
      expect(current.getIsRunning()).toBe(true)
      survivors.push(current)
    })
  })

  test('should keep running after a stop and start within one evaluation', () => {
    withHotRuntime(() => {
      const scheduler = new Scheduler({ timezone: 'Asia/Tokyo' })

      scheduler.start()
      scheduler.stop()
      scheduler.start()

      // Restarting re-claims the same identity, so the first start()'s
      // teardown must not run against the interval the second just created.
      expect(scheduler.getIsRunning()).toBe(true)
      survivors.push(scheduler)
    })
  })

  test('should give up its slot when stopped', () => {
    withHotRuntime(() => {
      const scheduler = new Scheduler({ timezone: 'Pacific/Auckland' })

      scheduler.start()
      expect(hasRegisteredSlot('scheduler', 'Pacific/Auckland')).toBe(true)

      scheduler.stop()

      // Otherwise the registry holds this scheduler — and every task closed over
      // by its teardown — for the rest of the process.
      expect(hasRegisteredSlot('scheduler', 'Pacific/Auckland')).toBe(false)
    })
  })

  test('should leave schedulers alone outside a hot-reloading runtime', () => {
    const previous = new Scheduler({ timezone: 'Europe/Berlin' })
    previous.start()

    const current = new Scheduler({ timezone: 'Europe/Berlin' })
    current.start()

    expect(previous.getIsRunning()).toBe(true)
    survivors.push(previous, current)
  })
})
