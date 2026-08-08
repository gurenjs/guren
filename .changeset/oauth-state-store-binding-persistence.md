---
'@guren/core': patch
'@guren/server': patch
---

Persist the OAuth state binding in the shared state stores

`createOAuthState` recorded the browser binding in the payload, but
`DatabaseOAuthStateStore` and `RedisOAuthStateStore` neither wrote nor restored
it. Every bound state came back unbound, and `verifyOAuthState` then accepted
any browser — so `authorize({ bindTo })` was inert on both shared stores,
including the database store the docs recommend for production. Only the
in-process memory store, which the docs tell you not to deploy, carried it.

Both stores now round-trip `binding`. The database store needs a nullable
`binding` column on the `oauth_states` table; without it the state cannot be
persisted at all.

`bindingMatches` also moves to `secureCompare`, the hex-decoding comparator, to
match the other stored-hash comparison in the package.
