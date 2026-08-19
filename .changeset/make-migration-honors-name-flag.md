---
"@guren/cli": patch
---

Honor `--name` on `make:migration` (`db:make`), and take the last value of a repeated flag.

`guren make:migration --name add_posts_table` — the form the database guide documents — generated a migration under a name drizzle-kit invented (`20260819113244_unusual_triton`) rather than the one given. The argument was declared as a positional, and citty resolves positionals and string flags from different places: `--name <value>` arrived with neither a `name` key nor the value among the positionals, and no unknown-flag error to say so, so drizzle-kit was called with no name at all and fell back to naming the migration itself. Nothing about the run looked like a failure — the migration is generated and correct, only misnamed, which is the kind of thing noticed later when hunting for it by name. Both spellings work now: `--name <name>`, and the bare positional (`guren make:migration add_posts_table`) that the scaffolding skills use.

Repeating any of the command's three flags is also handled. citty types a `string` argument as `string | undefined` and then hands back a `string[]` when the flag appears twice, which each argument failed on differently: `--schema a/schema.ts --schema b/schema.ts` was comma-joined into a path nothing can open and still exited 0, and once `--name` started being read it would have thrown `options.name?.trim is not a function`. The last value wins, as it does everywhere else.
