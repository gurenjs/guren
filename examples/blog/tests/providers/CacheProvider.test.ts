import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Container } from '@guren/core'

const { createRedisClient } = vi.hoisted(() => ({
  createRedisClient: vi.fn(() => ({}) as never),
}))

vi.mock('@guren/core', async () => {
  const actual = await vi.importActual<typeof import('@guren/core')>('@guren/core')
  return {
    ...actual,
    createRedisClient,
  }
})

// The provider memoizes its manager at module scope, so every case takes a
// fresh module instance rather than the one a previous case already built.
async function loadProvider() {
  vi.resetModules()
  return await import('../../app/Providers/CacheProvider.js')
}

describe('Blog CacheProvider', () => {
  const originalCacheStore = process.env.CACHE_STORE

  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.CACHE_STORE
  })

  afterEach(() => {
    if (originalCacheStore === undefined) {
      delete process.env.CACHE_STORE
    } else {
      process.env.CACHE_STORE = originalCacheStore
    }
  })

  it('registers a singleton cache manager in the container', async () => {
    const { default: CacheProvider, getCacheManager } = await loadProvider()
    const container = new Container()

    new CacheProvider(container).register()

    expect(container.make('cache')).toBe(container.make('cache'))
    expect(getCacheManager()).toBe(getCacheManager())
    expect(container.make('cache')).toBe(getCacheManager())
  })

  it('defaults to the memory store and leaves redis undialed', async () => {
    const { getCacheManager } = await loadProvider()
    const cache = getCacheManager()

    expect(cache.getDefaultStoreName()).toBe('memory')
    expect(cache.hasStore('redis')).toBe(true)
    // The point of registering redis as a factory rather than a `stores` entry:
    // the client is only built once something selects the store.
    expect(createRedisClient).not.toHaveBeenCalled()
  })

  it('selects the store named by CACHE_STORE', async () => {
    process.env.CACHE_STORE = 'redis'

    const { getCacheManager } = await loadProvider()

    expect(getCacheManager().getDefaultStoreName()).toBe('redis')
  })
})
