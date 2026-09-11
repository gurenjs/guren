---
"@guren/server": patch
---

Give `LogServiceProvider` a usable default channel

The provider bound a `LogManager` whose `default` named `console` while
`channels` declared nothing, so the first `log.info()` or `log.channel()`
through the container threw `Log channel [console] is not defined`. The
default is now a declared console channel.

The provider also publishes the bound manager as the global one in `boot()`, so
`getLogManager()` works in an app that registers it instead of throwing "Log
manager has not been initialized". `BroadcastServiceProvider` and
`NotificationServiceProvider` do the same for `getBroadcastManager()` and
`getNotificationManager()`, which had the same gap. Each replaces a manager the
app set itself, as `EncryptionServiceProvider` does.
