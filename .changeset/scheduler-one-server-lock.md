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
  of the run that replaced it. A `when()` / `skip()` that rejects releases the
  guard rather than pinning the task.
- `runOnOneServer()`: `createScheduler({ lock })` takes a `SchedulerLock`
  (`acquire(key, ttlSeconds)`, `release(key)`). It defaults to
  `MemorySchedulerLock`, which holds for one process; the first such task on
  the default lock warns once, naming `createScheduler({ lock })` and
  `RedisSchedulerLock` (`@guren/core/redis`) for a multi-server deploy. The
  claim is per task per minute and stays held for an hour, so a server whose
  clock reaches the minute later does not re-run it. A task with no `.name()`,
  or an empty one, is refused when it is registered and again at `start()` --
  there is nothing to key the claim on. `createScheduler({ lockPrefix })` namespaces the
  keys for two apps sharing one store.
- A lock that rejects is reported as a lock failure rather than a task failure,
  and the task does not run.
- `runDueTasks()` runs the due tasks concurrently. Awaited one by one, a slow
  task pushed the rest past their minute, where the once-per-minute tick
  dropped them. Each task's own overlap guard still serialises it with itself.
- `ScheduledTask.tryRun()` is `run()` resolving to whether the callback ran;
  `run()` still resolves to nothing.
- `guren schedule:list` shows the two guards in a Flags column and in `--json`;
  `guren schedule:run` reports a task its own guards declined as `Skipped:`,
  and warns that it cannot enforce `runOnOneServer()`.
