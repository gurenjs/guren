---
'@guren/server': patch
'@guren/core': patch
---

Collapse the duplicated store expiry rules into a single implementation

`toDate`, `isExpired` and `toOptionalExpiry` existed twice: once in
`packages/server/src/support/expiry.ts` for the Redis-backed stores and the
authoritative `verifyApiToken` / OAuth checks, and once in
`packages/core/src/store-utils.ts` for the database-backed stores. The copies
were identical and deliberate — `@guren/core` depends on `@guren/server` and
not the other way around, so core was unreachable from the server package —
but two copies of an expiry rule is how the next boundary-case fix lands in
one backend and silently misses its sibling. That is the failure mode the
Redis and database stores have already hit once.

`@guren/server` now exposes the rules on a `@guren/server/support/expiry`
subpath and `packages/core/src/store-utils.ts` re-exports them, leaving one
implementation for both backends. The dependency direction already ran
core → server, so this adds no cycle.

No behavior change and no public API change: the two implementations were
byte-identical, and neither package's index exports these — `@guren/core`'s
index opens with `export * from '@guren/server'`, so a test now pins that they
stay off the public surface. `decodeJsonColumn` stays in core as a drizzle
column concern; the Redis stores decode their payloads through
`redis-values.ts`.
