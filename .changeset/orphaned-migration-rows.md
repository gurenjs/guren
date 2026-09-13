---
"@guren/orm": minor
"@guren/cli": minor
---

Report migrations the database applied but no folder on disk carries

A migration a dev server applied while a generator was still writing files, and
whose folder `git clean` removed afterwards, left a row in the tracker, its
tables in the database, and nothing on disk to show for either. The drizzle
migrator matches migrations by name and skips such a row, `db:status` listed
only the folders it found, and the first sign was a later migration failing
with `table ... already exists`.

- `migrationStatus()` now returns those rows too, with `orphaned: true`. Entries
  for local migrations are unchanged and carry no `orphaned` key. With no
  migration folder on disk at all it still returns `[]` without connecting, as
  before, so a tracker whose every folder is gone is not reported there.
- `bun run db:status` marks them `! orphaned`, explains what is left behind, and
  no longer prints "All migrations applied." while one exists. `--json` rows
  gain an `orphaned` boolean.
- A boot that migrates warns once, before the migrator runs, naming every
  orphaned migration. A database whose tracker matches its folder boots as
  quietly as before.
