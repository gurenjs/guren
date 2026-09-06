---
'@guren/core': minor
'@guren/server': patch
---

`createSessionManager()`: the `database` session driver (RFC 0020 Part 2a)

`SessionManager` (RFC 0020 Part 1) ships `memory` and `redis`; the
database-backed store cannot live in `@guren/server`, which must not depend on
the ORM. `@guren/core` now closes that:

- `createSessionManager(config)` builds a `SessionManager` with the `database`
  driver registered, and `declare module '@guren/server'` widens
  `SessionDrivers` so `{ driver: 'database', table: sessions }` type-checks in
  an app's config. The driver takes the app's own drizzle `sessions` table plus
  `DatabaseSessionStore`'s options (`dataMode`), and `pruneExpired()` sweeps it.
- `registerDatabaseSessionDriver(manager)` adds the driver to a manager built
  elsewhere.
- Registration is a factory call, never a module side effect, so a bundler that
  drops an unused import cannot drop the driver with it.

`@guren/server`: an unknown session driver's error now names the drivers that
*are* registered, which is what tells a `new SessionManager()` caller that
`database` comes from `@guren/core`.
