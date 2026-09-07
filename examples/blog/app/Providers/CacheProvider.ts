import {
  ServiceProvider,
  createCacheManager,
  createRedisClient,
  type CacheManager,
} from '@guren/core'

let cacheManager: CacheManager | null = null

function createBlogCacheManager(): CacheManager {
  return createCacheManager({
    // CACHE_STORE=memory is per-process: correct on one long-lived server,
    // wrong on Workers, Lambda and Vercel, where two requests can land in
    // different instances. `redis` needs REDIS_URL.
    default: process.env.CACHE_STORE || 'memory',
    stores: {
      memory: { driver: 'memory' },
      // `client` is a function so the client is constructed only when
      // CACHE_STORE selects this store: an entry's options are evaluated with
      // the object around them, and ioredis dials on construction.
      redis: { driver: 'redis', client: () => createRedisClient({ url: process.env.REDIS_URL }) },
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
