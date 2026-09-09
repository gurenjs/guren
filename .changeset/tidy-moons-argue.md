---
"@guren/orm": minor
---

Name the migrations a boot applied

Every driver but the Data API adapter applies pending migrations on the first
`getDatabase()` / `configureOrm()` call, and did so without a word. A migration
folder nobody meant to keep — one a generator wrote on a branch that was then
deleted, which `git switch` and `git branch -D` both leave on disk — reached the
database in silence, and surfaced much later as a table nobody remembered
creating.

A run that applies something now prints one line naming what it applied and the
folder it came from. A boot with nothing pending stays silent, so this does not
add a line to every restart.
