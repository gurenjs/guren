---
'@guren/server': patch
---

Fix queued notifications delivering nothing

A notification with `static shouldQueue = true` was queued and picked up by the
worker, but no channel was ever invoked. Serialization spread the notification
into a plain payload (`{ ...notification }`), which copies only own enumerable
properties — `via`, `toMail`, `toDatabase` and `toSlack` all live on the
prototype and were dropped. The job handler then rebuilt a shim that read the
delivery channels from a `_viaChannels` field nothing ever wrote, so `via()`
returned an empty list and the send loop had nothing to iterate. The
synchronous path was unaffected.

Queued notifications are now rebuilt as real instances. Notification classes
are recorded in a registry keyed on `notification.type` and restored with
`Object.create(prototype)`, which brings back every prototype method without
re-running the constructor (constructor arguments are not recoverable from a
payload). Registration happens automatically when a notification is queued,
which covers a worker sharing the dispatching process; a worker in a separate
process should call the newly exported `registerNotification()` at boot, and an
unregistered type now throws instead of failing silently.

Routing survives the queue too. The worker used to guess a notifiable's routes
from a `${channel}Route` property convention that the documented `Notifiable`
does not follow, so a queued notification to a user routing Slack via
`this.slackId` silently fell back to the org-wide webhook. `routeNotificationFor()`
is arbitrary user code — frequently a closure on an object literal — and cannot
be rebuilt from a payload, so it is now called at dispatch and the resolved
routes travel with the job. Payloads written before this release still fall
back to the old convention.

The job itself was also unreachable from a dedicated worker. It was registered
only as a side effect of dispatching, under the name of an internal per-manager
subclass, so `guren queue:work` running as its own process failed every
notification with `Job class not found`. That subclass is gone — since the
queue registry keys on the class name, every manager overwrote the same entry
anyway — leaving one `SendNotificationJob` that `NotificationServiceProvider`
registers on boot via the new `NotificationManager#registerQueueJob()`.

Also: `createdAt` is serialized explicitly and revived as a `Date`, so drivers
that persist JSON (Redis, SQS) no longer hand channels a string. `Notifiable`
gained an optional `notifiableType`, honored by `DatabaseChannel` through the
newly exported `resolveNotifiableType()`, so a notifiable rebuilt from a
payload keeps its original type name instead of recording `Object`.

Because rebuilt notifications are real instances, a user-defined `shouldSend()`
is now honored on the queued path; the previous shim hardcoded it to `true`.
