---
'@guren/orm': patch
---

Stop a superseded connection attempt from evicting a newer one

Every database factory memoizes its connection and migration handle in a
promise, clearing it on rejection so the next caller retries. The clear was
unconditional, so a rejection arriving after `closeDatabase()` (or
`resetDatabase()`) had already dropped the handle and a newer attempt had
replaced it would evict that newer attempt — a second connection where one was
expected. Clearing now happens only while the cell still holds the attempt that
failed. The five drivers share one internal `singleFlight()` helper instead of
hand-rolling the pattern eight times.
