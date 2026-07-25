---
'@guren/server': minor
'@guren/core': minor
---

Reduced session write volume (RFC 0003 Part 3): the session middleware no longer persists on every request, which matters anywhere writes are metered (Cloudflare D1's free tier allows 100k row writes/day — previously every page view consumed one).

- **Empty new sessions are not persisted and issue no cookie.** An anonymous request that never stores anything now costs zero store operations. Sessions (and their cookie) appear the moment anything is stored. Apps that relied on every visitor receiving a session cookie unconditionally will see it appear on first actual session use instead. (With the default auth stack this happens on the first CSRF-protected page, unchanged for now.)
- **Flash aging only dirties sessions that carried flash data**, instead of marking every loaded session dirty on every request.
- **New optional `SessionStore.touch(id, ttlSeconds)`** — rolling expiry for unchanged sessions becomes a TTL refresh instead of a full data rewrite. Implemented in `MemorySessionStore`, `RedisSessionStore` (EXPIRE), and `DatabaseSessionStore` (single UPDATE). Stores without `touch` keep the previous full-write fallback, and touching a missing session is a no-op — an expired session is no longer resurrected as an empty row by its stale cookie.
