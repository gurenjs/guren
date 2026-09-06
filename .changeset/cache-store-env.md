---
"@guren/cli": minor
"create-guren-app": patch
---

**`guren add cache` reads `CACHE_STORE`** — the scaffolded `CacheProvider` hardcoded `default: 'memory'` and ignored the variable, while the app template shipped a `CACHE_STORE=memory` line nothing read. The provider now selects with `process.env.CACHE_STORE ?? 'memory'` and declares a `redis` store alongside `memory`, and the blueprint appends the `CACHE_STORE` entry to `.env.example` when it installs the provider. The dead line is gone from the scaffolded `.env.example`, which now gains the variable only once an app has a provider that reads it.

The `redis` entry passes `client` as a function: a config entry's options are evaluated with the object around them, and ioredis dials on construction, so passing a client directly would open a connection on every boot even when `CACHE_STORE` never selects it.
