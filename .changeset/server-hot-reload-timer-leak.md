---
'@guren/server': patch
---

Fixed leaked interval timers under `bun --hot`. Each hot reload re-runs the module graph in the same process, and a `setInterval` callback keeps its owner reachable — so the cache sweep, rate-limit cleanup, SSE ping, and scheduler timers built by the previous evaluation went on firing against objects nothing referenced any more, one extra timer per reload. The rate-limit and SSE timers are not `unref()`ed, so those also duplicated work and held the process open on their own; a duplicated scheduler would have run every scheduled task twice per reload. Each owner now parks its teardown on a `globalThis` registry — the same approach `Application.listen()` already uses for the Bun and Vite dev servers — and stops its predecessor before taking over.

This only applies under `bun --hot`. An owner is identified by the file that built it plus a discriminator (the cache store's name, the rate-limit store's class, the scheduler's timezone), so it is replaced only by a later evaluation of that same file. Nothing is ever torn down automatically in production, tests, CLI commands, or serverless.

Three things to know. Cache stores are tracked from the cache configuration, so a store built by calling `new MemoryStore()` directly in application code is not covered — every path the templates and examples take goes through cache config. Broadcast managers are tracked from `createBroadcastManager()`, so a bare `new BroadcastManager()` is likewise left alone. And because every manager built through `createCacheManager()` reports that factory as its call site, the store name is the whole of a cache store's identity: two cache managers in one process would share a slot per store name, so the second store under a given name stops the first one's sweep. Apps have one cache manager.

As part of this, `BroadcastManager` gained a public `disconnectAll()` that closes every SSE connection it is holding, which is what stops those connections' ping timers.
