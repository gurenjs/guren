---
"@guren/server": minor
"@guren/core": minor
"@guren/cli": patch
---

Honour `runOnOneServer()` and `preventOverlapping(expiresAt)`, and run due tasks concurrently

Both builder calls were accepted and stored, and nothing read them: a task
marked `runOnOneServer()` ran on every server, and a hung run under
`preventOverlapping()` blocked its successors forever whatever expiry was
passed.

- `preventOverlapping(expiresAt)`: the in-memory guard now expires after
  `expiresAt` milliseconds, and a run that outlived it cannot clear the guard
  of the run that replaced it.
- `runOnOneServer()`: `createScheduler({ lock })` takes a `SchedulerLock`
  (`acquire(key, ttlSeconds)`, `release(key)`). `MemorySchedulerLock` ships
  for a single process; `RedisSchedulerLock` (`@guren/core/redis`) for a
  multi-server deploy. The claim is per task per minute and stays held for an
  hour, so a server whose clock reaches the minute later does not re-run it.
  A scheduler holding such a task with no `lock`, or one with no `.name()`,
  throws at `start()` and `runDueTasks()` rather than run it everywhere.
- `runDueTasks()` runs the due tasks concurrently. Awaited one by one, a slow
  task pushed the rest past their minute, where the once-per-minute tick
  dropped them. Each task's own overlap guard still serialises it with itself.
- `ScheduledTask.run()` resolves to whether the callback ran.
- `guren schedule:list` shows the two guards in a Flags column and in `--json`;
  `guren schedule:run` warns that it cannot enforce `runOnOneServer()`.
