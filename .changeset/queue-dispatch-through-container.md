---
"@guren/server": patch
---

Resolve the queue driver for `Job.dispatch()` through the container

`Job.dispatch()` read a module-level driver that `QueueManager.driver()` set
as a side effect of its first call, and `QueueServiceProvider` bound a manager
nobody resolved. An app that registered the provider and a driver, and never
happened to call `manager.driver()` itself, got "Queue driver not configured"
on its first dispatch.

`getQueueDriver()` now falls back to the default driver of the `QueueManager`
bound as `queue` in the container when the global slot is empty, so
`Job.dispatch()` and `Mail.queue()` work off the provider alone. The global
set by `setQueueDriver()` (and by `manager.driver()`) still wins when present.
The error for an app with neither names the provider to register.
