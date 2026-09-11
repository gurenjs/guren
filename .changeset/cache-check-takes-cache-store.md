---
"@guren/server": minor
---

Let `CacheCheck` take the framework's own `CacheStore`

The health check expected a store with `put` / `forget`, methods no Guren
cache store has (`CacheStore` exposes `set` / `delete`), so the built-in check
could not be handed the built-in store without a cast that then failed at
runtime. `CacheStoreInterface` is now `Pick<CacheStore, 'get' | 'set' |
'delete'>`, which `cache.store()` and every shipped store satisfy.

This is a source break for an object written against the old shape: a store
exposing `get` / `put` / `forget` no longer compiles against the constructor,
and the check reports it unhealthy at runtime, since the methods it calls are
not there. Rename those members to `set` and `delete`, or pass a `CacheStore`.
