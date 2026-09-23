---
'@guren/server': patch
---

`MemoryRateLimitStore` and `SlidingWindowRateLimitStore` now `unref()` their 60-second cleanup timer, as the memory cache store already did. A process that only built one (a CLI command or script evaluating a routes module that calls `createRateLimitMiddleware()`, a test file) exits on its own instead of staying alive forever. The sweep still runs while a server keeps the process up, and `destroy()` still stops it.
