import { defineCacheConfig } from '@guren/core'
import { createRedisClient } from '@guren/core/redis'

// CACHE_STORE picks the store. `memory` is per-process: correct on one
// long-lived server, wrong on Workers, Lambda and Vercel, where two requests
// can land in different instances. `redis` needs REDIS_URL.
export default defineCacheConfig((env) => ({
  default: env.CACHE_STORE,
  stores: {
    memory: { driver: 'memory' },
    // A function, so ioredis dials only once CACHE_STORE selects this store.
    redis: { driver: 'redis', client: () => createRedisClient({ url: env.REDIS_URL }) },
  },
}))
