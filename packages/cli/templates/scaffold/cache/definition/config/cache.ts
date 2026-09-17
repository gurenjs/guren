import { defineCacheConfig } from '@guren/core'

// CACHE_STORE picks the store. `memory` is per-process: correct on one
// long-lived server, wrong on Workers, Lambda and Vercel, where two requests
// can land in different instances.
const stores = {
  memory: { driver: 'memory' },
  // For Redis, add `createRedisClient` from '@guren/core/redis' and a
  // `redis: { driver: 'redis', client: () => createRedisClient({ url: env.REDIS_URL }) }`
  // entry, with REDIS_URL declared in config/env.ts. Import it only where you use
  // it, since that module pulls in ioredis. The function runs when the store is
  // first resolved, so no connection opens until CACHE_STORE selects it.
} as const

export default defineCacheConfig((env) => {
  // Checked at boot: the manager accepts any name and throws on the first cache call.
  if (!Object.hasOwn(stores, env.CACHE_STORE)) {
    throw new Error(
      `CACHE_STORE="${env.CACHE_STORE}" is not a declared store. Declare it in config/cache.ts or use one of: ${Object.keys(stores).join(', ')}.`,
    )
  }

  return { default: env.CACHE_STORE, stores }
})
