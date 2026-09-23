---
"@guren/server": patch
---

Warn when a different class registers under a job, event or notification name another class already holds. `registerJob()`, `EventManager.on()` / `listen()` / `registerEvent()` and `registerNotification()` (including the automatic registration when a notification is queued) print one warning per name that names both classes and the fix: a distinct class name, or a pinned `jobName`, `eventName` or `type`. Registering the same class again stays silent, and the registries still keep the class registered last, so nothing but the log changes. A future major will throw instead.
