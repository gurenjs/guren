import { defineCacheConfig } from '@guren/core'

// CACHE_STORE picks the store. `memory` is per-process: correct on one
// long-lived server, wrong on Workers, Lambda and Vercel, where two requests
// can land in different instances.
export default defineCacheConfig((env) => ({
  default: env.CACHE_STORE,
  stores: {
    memory: { driver: 'memory' },
    // For Redis, add `createRedisClient` from '@guren/core/redis' and a
    // `redis: { driver: 'redis', client: () => createRedisClient({ url: env.REDIS_URL }) }`
    // entry, with REDIS_URL declared in config/env.ts. Import it only where you use
    // it, since that module pulls in ioredis. The function runs when the store is
    // first resolved, so no connection opens until CACHE_STORE selects it.
  },
}))
