---
"@guren/server": minor
---

Wire queued event listeners to the queue, and register `Listener` classes with `events.listen()`

A listener registered with `{ queue }` ran inline: `EventManager` only sent it
to a queue once `setQueueDispatcher()` had been called, and nothing in the
framework called it. The `Listener` base class carried `shouldQueue`, `queue`
and `priority` statics that nothing read either.

- `EventServiceProvider` installs a queue dispatcher in `boot()`, whether or
  not a `queue` is bound yet: the dispatcher resolves the driver per emit, so a
  queue provider registered after this one, or resolved lazily, is still
  reached. The carrier job is registered in every booted process, including a
  worker that never emits.
- An emit sends one message per *queued listener*, not one per queue, so a
  listener that throws retries on its own rather than re-running the ones
  beside it. The worker runs the listener the message names; a message naming a
  listener it did not register fails rather than running a different one.
- A `{ queue }` listener with no queue reachable warns once, naming the wiring,
  and runs inline. A future major will throw there.
- `events.listen(ListenerClass)` registers a `Listener` subclass under its own
  statics, builds the instance per event, and calls `shouldHandle()` first. A
  throwing `handle()` propagates, and `failed()` reports it: inline on the
  throw, and on a queue once the carrier job has used its retries, the point
  `Job.failed` describes.
- A `once` listener with a queue is removed when it has run, on the worker,
  rather than when it was dispatched.
- A queued event carries its `Date` fields as a tagged value, so they come back
  as Dates rather than strings through a driver that serializes. The worker
  rebuilds the event as an instance of a registered class and refuses a name it
  has none for; `events.registerEvent(EventClass)` registers one explicitly,
  and an own `static eventName` pins the wire name the way `jobName` does.
- `EventManager.handleQueued()` and `registerEvent()` are new; a
  `QueueEventDispatcher` resolves whether it queued the emit, and only an
  explicit `false` sends the listener down the inline path.
