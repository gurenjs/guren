---
"@guren/cli": minor
"create-guren-app": patch
---

**`guren add cache` reads `CACHE_STORE`** — the scaffolded `CacheProvider` hardcoded `default: 'memory'` and ignored the variable, while the app template shipped a `CACHE_STORE=memory` line nothing read. The provider now selects with `process.env.CACHE_STORE ?? 'memory'`, and the blueprint appends the `CACHE_STORE` entry to `.env.example` when it installs the provider. The dead line is gone from the scaffolded `.env.example`, which now gains the variable only once an app has a provider that reads it.

The provider declares `memory` alone and documents the `redis` entry in a comment, as `guren add session` does: importing `createRedisClient` pulls ioredis into every bundle, on a runtime that may never select it. That entry passes `client` as a function, so the client is constructed when the store is first resolved rather than when the config object is built.
