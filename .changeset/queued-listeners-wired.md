---
"@guren/server": minor
---

Wire queued event listeners to the queue, and register `Listener` classes with `events.listen()`

A listener registered with `{ queue }` ran inline: `EventManager` only sent it
to a queue once `setQueueDispatcher()` had been called, and nothing in the
framework called it. The `Listener` base class carried `shouldQueue`, `queue`
and `priority` statics that nothing read either.

- `EventServiceProvider` now installs a queue dispatcher in `boot()` when the
  app binds a `QueueManager` as `queue`. An emit sends one `QueuedEventJob`
  per queue per event; the worker runs every listener registered for that
  event on that queue through the app's `events` binding, so the worker
  process registers listeners the same way the web process does. An app that
  builds its own manager wires it with
  `events.setQueueDispatcher(createQueueEventDispatcher())`.
- A `{ queue }` listener with no dispatcher makes `emit()` throw, naming the
  wiring, rather than run inline.
- `events.listen(ListenerClass)` registers a `Listener` subclass under its own
  statics, calls `shouldHandle()` first, and routes a throwing `handle()` to
  `failed()` when the class defines it.
- `EventManager.handleQueued()` and `hasQueueDispatcher()` are new.
