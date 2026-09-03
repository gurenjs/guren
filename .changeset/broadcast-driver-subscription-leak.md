---
'@guren/server': patch
---

Release the broadcast driver subscription when a client leaves a channel or
disconnects.

`BroadcastManager.subscribeClient()` and `subscribeWebSocketClient()` called
`driver().subscribe()` and dropped the unsubscribe function it returned, so
`unsubscribeClient()`, `unsubscribeWebSocketClient()`, `removeWebSocketClient()`
and an SSE stream's teardown only cleared the client's own channel set. The
driver-level subscription stayed registered for the life of the process: the
memory driver kept fanning out to a callback whose guard always said no, and
the Redis driver never sent the `UNSUBSCRIBE` that closes the channel once its
last local subscriber is gone. Subscribing the same client to the same channel
twice also registered two callbacks and delivered every event twice.

The manager now keeps the unsubscribe function per client and channel, calls
it from every leave path, and ignores a repeat subscribe for a pair it already
holds.

`MemoryDriver` now caps the published-event record it keeps for tests at
`maxPublishedEvents` (default 1000, oldest dropped first; `0` disables
recording) instead of growing for as long as the process publishes. The
option is exported from `@guren/core` as `BroadcastMemoryDriverOptions`.
`RedisDriver` drops an `initialized` field nothing read.
