---
"@guren/server": patch
---

Give `LogServiceProvider` a usable default channel

The provider bound a `LogManager` whose `default` named `console` while
`channels` declared nothing, so the first `log.info()` or `log.channel()`
through the container threw `Log channel [console] is not defined`. The
default is now a declared console channel.
