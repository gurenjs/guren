---
'@guren/server': patch
---

Make the Redis counters atomic.

`RedisStore.increment()`/`decrement()` checked `EXISTS`, wrote `0`, then
ran `INCRBY` — three round trips during which two concurrent callers could
both see the key as missing, both write `0`, and lose an increment. Redis
already treats a missing key as `0` and keeps an existing key's TTL, so each
method is now the single `INCRBY`/`DECRBY`.

`RedisSlidingWindowRateLimitStore.increment()` sent its trim, insert, and
count through a pipeline, which batches commands but does not stop Redis
interleaving other clients between them, so concurrent callers could read the
same count. The three steps now run in one Lua script, matching the
fixed-window store, so every caller is handed a distinct count.
