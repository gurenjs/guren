---
'@guren/server': patch
'@guren/core': patch
---

Treat an unparseable expiry as expired, at the point the decision is made

`new Date(garbage)` is an Invalid Date, and every comparison against one is
false. So `new Date() > token.expiresAt` and `payload.expiresAt.getTime() <= now`
both read a corrupt expiry as *not past*, and the record never expired.

The authoritative checks are `verifyApiToken` and the OAuth state store's expiry
tests, not any one store's deserialization — a token reaches `verifyApiToken`
from `MemoryApiTokenStore`, from the database and Redis stores, and from
application-supplied stores the framework never sees. `createApiToken` could also
mint an Invalid Date on its own from a non-finite `expiresIn`, with no store
involved at all. Both now go through a shared predicate in
`@guren/server/support/expiry`, so the rule holds for every implementation
including ones written by users.

Store-level coercion is kept as defense in depth and is now consistent. `toDate`
promised in its docstring that unparseable values return `null` but passed
`Date` instances wrapping garbage straight through, which is why `isExpired`
carried a second NaN check of its own; it now normalizes through one path and
handles the `bigint` a BIGINT column returns. `toOptionalExpiry` keeps absent
(`null`, "never expires") and present-but-unparseable distinct, degrading the
latter to a long-past date rather than to `null`. `RedisApiTokenStore`,
`RedisOAuthStateStore`, `RedisPasswordResetStore` and
`RedisEmailVerificationStore` all read their expiry through the same helper —
the last two still had the original unguarded `new Date(parsed.expiresAt)`.
