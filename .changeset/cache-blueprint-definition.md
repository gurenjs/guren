---
'@guren/cli': minor
---

`guren add cache` writes a `config/cache.ts` definition and lists it in `createApp({ config })` when the app declares its environment in `config/env.ts` (RFC 0027 §2), instead of `CacheProvider` and `CoreCacheServiceProvider`. An app without `config/env.ts` gets the provider as before.
