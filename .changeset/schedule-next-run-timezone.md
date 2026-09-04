---
'@guren/cli': patch
---

Compute `schedule:list` / `schedule:run` "next run" with the scheduler's own cron evaluator.

The CLI carried a second estimator that ignored the task's timezone, the
day-of-month / month / day-of-week fields, and any expression it had no branch
for: `* 3 * * *` fell through and reported "now". `getNextRunTime` now walks
`parseCron` + `matchesCron` (through `toTimezone` for a timezone-bearing task)
forward from the next minute, which is the same predicate `ScheduledTask.isDue()`
fires on, so the listed time is the one the scheduler will actually use. An
expression that cannot match, or a timezone `Intl` does not know, shows as "-".
