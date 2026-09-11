---
"@guren/server": minor
---

Resolve the queue driver for `Job.dispatch()` through the container

`Job.dispatch()` read a module-level driver that `QueueManager.driver()` set
as a side effect of its first call, and `QueueServiceProvider` bound a manager
nobody resolved. An app that registered the provider and a driver, and never
happened to call `manager.driver()` itself, got "Queue driver not configured"
on its first dispatch.

- `getQueueDriver()` falls back to the default driver of the `QueueManager`
  bound as `queue` in the container when nothing is pinned, so
  `Job.dispatch()` and `Mail.queue()` work off the provider alone. A manager
  bound with no factory for its default reads as absent rather than throwing,
  and the dispatch error says which of the two cases it is.
- `QueueManager.driver()` and `setDefaultDriver()` no longer publish the
  module-level driver; `setQueueDriver()` is its only writer. Resolving a
  driver used to pin the first booted app's queue for every later
  `Application` in the process, which sent a second app's jobs to the first
  app's driver. An app that relied on `manager.driver()` publishing, and binds
  no `queue` in the container, now calls `setQueueDriver()` itself.
- `clearQueueDriver()` drops the pin.
