---
'@guren/server': minor
---

`SessionManager`: named session stores with lazy, plugin-extensible resolution (RFC 0020 Part 1)

- `SessionManager` (from `@guren/core`) takes a `SessionConfig`: cookie/TTL
  settings plus `stores`, a map of named `{ driver, ...options }` entries, and
  `default`, the one the middleware uses. `memory` and `redis` ship in server;
  a plugin adds a driver by augmenting the `SessionDrivers` interface and
  calling `registerDriver()`. Stores are built on first use and memoized, so a
  driver registered after construction still serves a store declared before it,
  and a declared-but-unselected `redis` entry opens no socket. An undeclared
  `default` fails at construction. `pruneExpired()` sweeps the default and any
  built store that supports it.
- Bind a manager under the container key `session` (a `SessionProvider`) and
  `AuthServiceProvider` resolves the default store through it on the first
  request, with `auth.sessionOptions` overriding the manager's cookie/TTL
  settings field by field. Binding a manager *and* setting
  `auth.sessionOptions.store` fails the boot.
- `createSessionMiddleware({ store })` accepts a function returning the store,
  called once on the first request.
- On Cloudflare Workers, AWS Lambda, or Vercel, the middleware warns once per
  process when it ends up on `MemorySessionStore`, the store that loses every
  login there.
