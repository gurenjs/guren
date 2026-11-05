---
'@guren/cli': patch
'create-guren-app': patch
---

`.guren/channels.gen.ts` writes one pattern for a channel that an authorizer and an event's `broadcastOn()` name with different parameters, such as `counters.{id}` and `counters.{counterId}`; the authorizer's spelling is kept. The header no longer says payloads are always `unknown`: they are read from each event's `broadcastWith()` or the literal a broadcast passes.
