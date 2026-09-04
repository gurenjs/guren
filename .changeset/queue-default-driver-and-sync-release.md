---
'@guren/server': patch
---

Make `QueueManager.setDefaultDriver()` change the instance default, and
document that `SyncDriver` retries immediately.

`setDefaultDriver(name)` swapped the global driver `Job.dispatch()` uses but
never reassigned the manager's own default, so `driver()` with no argument and
`getDefaultDriverName()` kept answering with the driver from construction. The
method now updates both, and publishes a driver that was already resolved by
name as the global rather than leaving it off the global slot.

`SyncDriver.release()` re-runs a released job at once and ignores the retry
delay. That is deliberate: nothing waits in a sync queue, so honoring the
default exponential backoff would block the dispatching caller for the full
delay, and a detached timer would move the failure off the call that surfaces
it. The driver, the `QueueDriver.release()` contract, the worker's retry path
and the queue guide now say so.
