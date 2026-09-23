---
"@guren/cli": patch
---

Separate database command definitions and result reporting from the builtin registry, preserving production protection, dry-run behavior, and reset sequencing.

`db:reset --json` and `db:fresh --json` no longer print "Dropping all tables..." to stdout ahead of the JSON result, and the production refusal of `db:seed`, `db:reset`, `db:fresh`, `queue:retry` and `queue:flush` now reports through the CLI's error path instead of exiting from inside the command.
