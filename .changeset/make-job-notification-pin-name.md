---
'@guren/cli': patch
---

`make:job` and `make:notification` pin the name a job or notification is stored under, as `make:event` already does. A new job declares `static override jobName = '<ClassName>'`. A new notification extends `Notification` and overrides `get type()` to return its class name on that class alone, so a class a bundler renames still resolves from queued messages and stored records. The pin equals the class name that was the default, so nothing already queued or stored changes key; a subclass, which inherits the getter, resolves by its own class name as before instead of taking its parent's key. Existing jobs and notifications are unaffected: only files scaffolded from now on carry the pin.

The notification scaffold was a plain class, so `notifications.send()` and `registerNotification()` rejected it at compile time. It now extends `Notification`. Its `toMail()` returns `text` instead of `body`, a field `NotificationMailMessage` does not have, which the mail channel dropped. Its `toDatabase()` returns the data alone, since the database channel already records `type` beside it.
