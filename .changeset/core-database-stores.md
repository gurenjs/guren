---
'@guren/core': minor
---

Added `DatabaseSessionStore` and `DatabaseOAuthStateStore` (RFC 0003 Part 3) — database-backed stores built on the Guren ORM, next to the existing `DatabaseApiTokenStore`. Both work on any configured connection (SQLite, Postgres, MySQL, Cloudflare D1), which makes them the serverless defaults: sessions no longer require Redis on Lambda/Vercel/Workers (reads are strongly consistent, so login → redirect → read works), and OAuth state survives the authorize redirect landing on a different instance than the callback — the default `MemoryOAuthStateStore` is per-isolate memory and cannot guarantee that.

Expired rows are treated as missing (and removed) on read; both stores expose `deleteExpired()` for scheduled bulk cleanup, mirroring `DatabaseApiTokenStore`. Schema shapes are documented on each class (`sessions`: `id`/`data`/`expiresAt`; `oauth_states`: `stateHash`/`provider`/`redirectTo`/`expiresAt`).
