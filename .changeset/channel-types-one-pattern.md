---
'@guren/cli': patch
---

`.guren/channels.gen.ts` writes one pattern for a channel that an authorizer and an event's `broadcastOn()` name with different parameters, such as `counters.{id}` and `counters.{counterId}`; the authorizer's spelling is kept.
