---
'@guren/server': patch
---

Keep the SIGINT/SIGTERM/exit teardown compiling under bun-types 1.4.0, which declares `process.off` with only a `"memoryPressure"` overload and thereby shadows the generic `EventEmitter.off` the signal names relied on. Runtime behavior is unchanged.
