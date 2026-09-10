---
"@guren/server": patch
---

Let `CacheCheck` take the framework's own `CacheStore`

The health check expected a store with `put` / `forget`, methods no Guren
cache store has (`CacheStore` exposes `set` / `delete`), so the built-in
check could not be handed the built-in store without a cast that then failed
at runtime. `CacheStoreInterface` is now `Pick<CacheStore, 'get' | 'set' |
'delete'>`, which `cache.store()` and every shipped store satisfy; a custom
object passed to the check must expose those three methods.
