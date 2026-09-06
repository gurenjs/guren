---
"@guren/server": minor
---

**The `redis` cache store accepts a `client` function** — `stores: { redis: { driver: 'redis', client: () => createRedisClient({ url: process.env.REDIS_URL }) } }` now works, matching what `SessionManager`'s redis driver already accepted. A config entry's options are evaluated with the object around them, so passing a constructed ioredis client opened a connection at boot even when another store was selected (with `REDIS_URL` unset, a retrying handle on `127.0.0.1:6379`). A function runs when the store is first resolved instead. Passing the client directly still works; a function returning a Promise throws, naming the cause. `CacheManager.store()` now names the declared stores when it cannot find one, as `SessionManager` does.
