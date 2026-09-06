import { type SessionConfig } from '@guren/core'
import { createRedisClient } from '@guren/core/redis'
import { sessions } from '../db/schema'

// Declared once, chosen per environment: set SESSION_DRIVER in .env (or in
// your platform's vars) to switch without touching code. Stores are built on
// the first request that needs one, so a store you never select never opens a
// connection — but the values below are read when this object is built, so
// keep anything that can throw (a required-env helper) out of it.
export const sessionConfig: SessionConfig = {
  default: process.env.SESSION_DRIVER ?? 'database',
  ttlSeconds: 60 * 60 * 2,
  stores: {
    // Survives restarts, isolates and cold starts, over the connection
    // configureOrm() already established. The `sessions` table this reads is
    // in db/schema.ts; run the migration before the first login.
    database: { driver: 'database', table: sessions },
    // Per-process only. Correct on one long-lived server, wrong on Workers,
    // Lambda and Vercel, where the login and the request after it can land in
    // different instances.
    memory: { driver: 'memory' },
    // Needs REDIS_URL. `client` is a function so this stays unopened until
    // SESSION_DRIVER selects it.
    redis: { driver: 'redis', client: () => createRedisClient({ url: process.env.REDIS_URL }) },
  },
}
