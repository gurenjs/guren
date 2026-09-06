import { ServiceProvider, createCacheManager, createRedisClient, RedisCacheStore } from '@guren/core'

export default class CacheProvider extends ServiceProvider {
  register(): void {
    this.container.singleton('cache', () => {
      const cache = createCacheManager({
        // CACHE_STORE=memory is per-process: correct on one long-lived server,
        // wrong on Workers, Lambda and Vercel, where two requests can land in
        // different instances. `redis` needs REDIS_URL.
        default: process.env.CACHE_STORE ?? 'memory',
        stores: {
          memory: { driver: 'memory' },
        },
      })

      // Registered as a factory rather than a `stores` entry: an entry's
      // options are evaluated with the config object, and ioredis dials on
      // construction, so a declared-but-unselected redis store would open a
      // connection on every boot. This runs only once CACHE_STORE selects it.
      cache.registerStore('redis', () => new RedisCacheStore({
        client: createRedisClient({ url: process.env.REDIS_URL }),
      }))

      return cache
    })
  }
}
