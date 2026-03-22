import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Container } from '@guren/core'

const { cacheManager, createCacheManager } = vi.hoisted(() => ({
  cacheManager: { store: vi.fn() },
  createCacheManager: vi.fn(() => ({ store: vi.fn() })),
}))

vi.mock('@guren/core', async () => {
  const actual = await vi.importActual<typeof import('@guren/core')>('@guren/core')
  return {
    ...actual,
    createCacheManager,
  }
})

import CacheProvider from '../../app/Providers/CacheProvider.js'

describe('API CacheProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createCacheManager.mockReturnValue(cacheManager)
  })

  it('registers a singleton cache manager in the container', () => {
    const container = new Container()
    const provider = new CacheProvider(container)

    provider.register()

    const first = container.make('cache')
    const second = container.make('cache')

    expect(first).toBe(second)
    expect(first).toBe(cacheManager)
    expect(createCacheManager).toHaveBeenCalledWith({
      default: 'memory',
      stores: {
        memory: { driver: 'memory' },
      },
    })
    expect(createCacheManager).toHaveBeenCalledTimes(1)
  })
})
