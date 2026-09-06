import { ServiceProvider, createCacheManager } from '@guren/core'

// CACHE_STORE picks the store. `memory` is per-process: correct on one
// long-lived server, wrong on Workers, Lambda and Vercel, where two requests
// can land in different instances.
//
// For Redis, add `createRedisClient` from '@guren/core/redis' and a
// `redis: { driver: 'redis', client: () => createRedisClient({ url: process.env.REDIS_URL }) }`
// entry — imported here only when you use it, since that module pulls in
// ioredis. The function runs when the store is first resolved, so a store
// declared beside `memory` opens no connection until CACHE_STORE selects it.
export default class CacheProvider extends ServiceProvider {
  register(): void {
    this.container.singleton('cache', () => createCacheManager({
      // `||`, not `??`: a blanked `CACHE_STORE=` is '', which names no store.
      default: process.env.CACHE_STORE || 'memory',
      stores: {
        memory: { driver: 'memory' },
      },
    }))
  }
}
