import { type SessionConfig } from '@guren/core'
import { sessions } from '../db/schema.js'

// SESSION_DRIVER picks a store per environment. `database` is the default
// because this app runs on Workers, where per-isolate memory does not survive
// between the login redirect and the next read.
export const sessionConfig: SessionConfig = {
  default: process.env.SESSION_DRIVER || 'database',
  stores: {
    database: { driver: 'database', table: sessions },
    // No table, no binding: everything in the session travels in the cookie,
    // so keep only ids there. wrangler.jsonc declares no SESSION_DRIVER, so
    // selecting this means adding the var and redeploying — it is not a switch
    // that can be flipped while D1 is down.
    cookie: { driver: 'cookie' },
  },
}
