---
"@guren/server": minor
"@guren/core": minor
"@guren/cli": patch
---

`oauth-states:prune` deletes expired rows from the `oauth_states` table. `DatabaseOAuthStateStore` only removes a row when that state is looked up again, so a sign-in abandoned before its callback left its row forever: `GET /auth/:provider` needs no authentication and writes one row per request.

`OAuthManager.pruneExpiredStates()` sweeps the state store through the optional `deleteExpired(now)` now declared on `OAuthStateStore`, and `@guren/core` ships `OAuthStatesPruneCommand` over it. `MemoryOAuthStateStore` sweeps on write and `RedisOAuthStateStore` expires its own keys, so neither implements the method and both are skipped.

`guren add oauth` registers the command in `src/console.ts` and lists scheduling it as a next step, as does `guren make:auth --oauth` when it appends the table. With no `db/schema.ts`, `make:auth` leaves OAuth state in memory and registers nothing.
