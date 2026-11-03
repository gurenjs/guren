# Sessions

A session keeps per-browser state between requests, and the session guard stores the signed-in user's identifier in it. This page covers how the session middleware is attached, the cookie options, and the stores a session can live in: memory, the database, an encrypted cookie or Redis. Signing users in is described in [Authentication](./authentication.md).

## Enabling Sessions

Guards need access to the session. When `createApp()` receives an `auth` option, `AuthServiceProvider` attaches the session middleware (and CSRF) for you. Pass options there to customize it:

```ts
import { createApp } from '@guren/core'

const app = createApp({
  auth: {
    autoSession: true, // set false to opt out
    sessionOptions: {
      cookieSecure: process.env.NODE_ENV === 'production',
    },
  },
})
```

Without the `auth` option you can mount the session middleware yourself, but nothing then attaches CSRF protection or the provider's session handling:

```ts
import { createApp, createSessionMiddleware } from '@guren/core'

const app = createApp()
app.use('*', createSessionMiddleware())
```

`cookieSecure` controls whether the session cookie is marked `Secure` (only sent over HTTPS). In production you should keep it `true`; in local development it is set to `false` by default so cookies work over http://localhost.

**Application auth options**
- `autoSession` (default `true`): automatically attaches `createSessionMiddleware`.
- `sessionOptions` (forwarded to `createSessionMiddleware`):
  - `cookieName` (default `guren.session`)
  - `cookieSecure` (default `true` in production, `false` in dev/local)
  - `cookieSameSite` (default `Lax`)
  - `cookieHttpOnly` (default `true`)
  - `cookieMaxAgeSeconds` (optional; falls back to `ttlSeconds`)
  - `ttlSeconds` (default 2 hours)
  - `store` (default in-memory; swap for your own implementation for multi-instance deployments). Accepts a store or a function returning one; the function is called on every request (a `SessionManager` memoizes), never at boot.

## Selecting a store with `SessionManager`

`bunx guren add session` writes the `sessions` table and its migration, `config/session.ts` (declaring the `database` and `cookie` stores), the `SESSION_DRIVER` key (declared in `config/env.ts` with a `database` default, and added to `.env` and `.env.example`), and the `sessions:prune` command, and lists the definition in `createApp({ config })`. The `redis` store below is the one addition you make by hand: importing `@guren/core/redis` pulls ioredis into every bundle, so the scaffold leaves it out until you want it. `guren add auth` runs it for you, so a scaffolded app is database-backed from the start. The rest of this section is what it produces, for an app wiring it by hand.

As with [`--oauth`](./oauth.md#oauth-login-buttons), an app without `config/env.ts`, or with a provider already binding `session`, gets `config/session.ts` as a plain `SessionConfig` and an `app/Providers/SessionProvider.ts` that binds it instead.

For more than one candidate store, declare them once and pick by environment. `defineSessionConfig` binds a `SessionManager` under the `session` key, and `AuthServiceProvider` builds the session middleware around it at boot, resolving the store itself on the first request:

```ts
// config/session.ts
import { defineSessionConfig } from '@guren/core'
import { createRedisClient } from '@guren/core/redis'
import { sessions } from '../db/schema'

export default defineSessionConfig((env) => ({
  default: env.SESSION_DRIVER,
  ttlSeconds: 60 * 60 * 2,
  stores: {
    // Survives restarts, isolates and cold starts, over the connection
    // `configureOrm()` already established — Postgres, MySQL, SQLite or D1.
    database: { driver: 'database', table: sessions },
    cookie: { driver: 'cookie' },
    // `client` may be a function: it runs when this store is first used, so a
    // store that is declared but not selected opens no connection.
    redis: { driver: 'redis', client: () => createRedisClient({ url: env.REDIS_URL }) },
  },
}))
```

Declare `REDIS_URL` in `config/env.ts`, and import `@guren/core/redis` only in the config that uses it, since it pulls in ioredis. List the definition beside the database one:

```ts
// src/app.ts
import { createApp } from '@guren/core'
import database from '../config/database.js'
import env from '../config/env.js'
import session from '../config/session.js'

const app = createApp({
  env,
  config: [database, session],
})
```

`defineSessionConfig()` builds its manager with `createSessionManager()`, which is `new SessionManager()` plus the `database` driver. Only `@guren/core` can supply that driver: the store wraps your table in an ORM model, and the HTTP layer underneath does not depend on the ORM. Use it whenever a `database` store is declared; `registerDatabaseSessionDriver(manager)` adds the driver to a manager you built some other way.

### The `cookie` store

`{ driver: 'cookie' }` keeps the whole session inside the cookie, encrypted under your `APP_KEY` (AES-256-GCM, with `APP_PREVIOUS_KEYS` accepted so a key rotation does not log everyone out). It is the one store that needs **no server-side resource at all** (no table, no migration, no Redis, no Workers binding):

```ts
stores: {
  cookie: { driver: 'cookie' },
}
```

Three things it cannot do, and you should decide against them deliberately:

- **Everything in the session travels in the cookie**, so it is capped. The middleware measures the whole `Set-Cookie` it is about to send — name and attributes included — against `maxCookieBytes` (4096 by default, what browsers keep) and throws rather than emitting one the browser silently drops. That leaves roughly 2.9 KB for the session itself. Keep records in the database and only their ids in the session.
- **A logout cannot revoke a cookie the client already copied.** `invalidate()` clears it on that client; the copy stays valid until it expires. Anything that must be revocable belongs in the database.
- **No "log out everywhere", and no session listing**: there is nothing server-side to enumerate.

Set `ttlSeconds` deliberately: nothing server-side can expire the cookie early, so the encrypted payload's own expiry is the only limit.

### The `database` store and boot checks

The `database` driver needs a `sessions` table in `db/schema.ts` and a migration. It has three columns: `id` (text primary key), `data`, and `expiresAt`. The dialect-specific shape is in the [Cloudflare guide](./cloudflare.md#sessions-and-oauth-state-must-be-database-backed). Sweep expired rows on a schedule with `manager.pruneExpired()`; `read()` already treats them as missing.

Cookie and TTL settings on the manager are the base, and `auth.sessionOptions` overrides them field by field. These mistakes fail the boot, so a typo in `SESSION_DRIVER` stops the app before the first login:

- setting `auth.sessionOptions.store` *and* binding a manager (nothing picks one silently)
- a `default` store whose driver nobody registered
- a `default` name that `stores` does not declare, caught when `AuthServiceProvider` builds the manager

`memory` is always declared, so `SESSION_DRIVER=memory` works without an entry. The manager is bound before any provider boots; see [Config definitions](./configuration.md#config-definitions).

A plugin adds a driver by augmenting the `SessionDrivers` interface and calling `manager.registerDriver(name, factory)`. Resolution is lazy, so the plugin's `register()` may run after the config was declared.

> [!WARNING]
> On Cloudflare Workers, AWS Lambda, or Vercel, requests share no memory, so the default `MemorySessionStore` loses a login on the very next request. The middleware warns once per process when it finds itself in that position; `guren check` and the deploy builds warn ahead of time.
