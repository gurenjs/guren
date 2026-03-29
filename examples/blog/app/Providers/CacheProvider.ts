import { ServiceProvider, createCacheManager, type CacheManager } from '@guren/core'

let cacheManager: CacheManager | null = null

function createBlogCacheManager(): CacheManager {
  return createCacheManager({
    default: 'memory',
    stores: {
      memory: { driver: 'memory' },
    },
  })
}

export function getCacheManager(): CacheManager {
  if (!cacheManager) {
    cacheManager = createBlogCacheManager()
  }

  return cacheManager
}

export default class CacheProvider extends ServiceProvider {
  register(): void {
    this.container.singleton('cache', () => getCacheManager())
  }
}
