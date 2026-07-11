---
"@guren/cli": minor
---

Real-app dogfooding round 3:

- **`guren schedule:run` actually runs tasks now.** The command previously printed "Would run: ..." and executed nothing (a leftover stub), so cron-driven `guren schedule:run` silently did no work. Due tasks (or all tasks with `--force`) now execute through `ScheduledTask.run()` with per-task success/failure reporting and a non-zero exit code on failure. Task names and cron expressions are also read correctly (previously every task displayed as "unnamed (* * * * *)").
- **`guren audit` recognizes generic call signatures** — `this.auth.userOrFail<{ id: number }>()` and `validateBody<T>(...)` no longer produce false "no authentication check" warnings.
