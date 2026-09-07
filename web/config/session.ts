import { type SessionConfig } from '@guren/core'
import { sessions } from '../db/schema.js'

// SESSION_DRIVER picks a store per environment. `database` is the default
// because this app runs on Workers, where per-isolate memory does not survive
// between the login redirect and the next read.
export const sessionConfig: SessionConfig = {
  default: process.env.SESSION_DRIVER || 'database',
  stores: {
    database: { driver: 'database', table: sessions },
    // No table, no binding — the fallback when D1 is unreachable. Everything
    // in the session travels in the cookie, so keep only ids there.
    cookie: { driver: 'cookie' },
  },
}
