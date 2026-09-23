---
'create-guren-app': patch
---

`--auth` no longer lists `bunx guren add auth` under "Add features:" once the scaffolder has run it. When the step fails after dependencies are installed, the warning no longer tells you to install them first, and the command stays in the list. The users table hint drops `bun run db:make` when `guren add auth` already generated the migration into `db/migrations`, and keeps it when no migration is there.
