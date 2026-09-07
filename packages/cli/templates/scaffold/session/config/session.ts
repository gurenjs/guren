import { type SessionConfig } from '@guren/core'
import { sessions } from '../db/schema'

// SESSION_DRIVER picks a store per environment. Stores are built on the first
// request that needs one, but the values below are read when this object is
// built, so keep anything that can throw (a required-env helper) out of it.
//
// `memory` is always available without an entry, and is per-process: correct
// on one long-lived server, wrong on Workers, Lambda and Vercel, where the
// login and the request after it can land in different instances.
//
// For Redis, add `createRedisClient` from '@guren/core/redis' and a
// `redis: { driver: 'redis', client: () => createRedisClient({ url: process.env.REDIS_URL }) }`
// entry — imported here only when you use it, since that module pulls in ioredis.
export const sessionConfig: SessionConfig = {
  // `||`, not `??`: a blanked `SESSION_DRIVER=` is '', which names no store.
  default: process.env.SESSION_DRIVER || 'database',
  ttlSeconds: 60 * 60 * 2,
  stores: {
    // Over the connection configureOrm() already established. The `sessions`
    // table is in db/schema.ts; run the migration before the first login.
    database: { driver: 'database', table: sessions },
  },
}
