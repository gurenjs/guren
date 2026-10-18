---
"@guren/orm": minor
"@guren/core": minor
"@guren/cli": minor
"create-guren-app": minor
---

Add the destructive-migration guard (RFC 0034). A pending migration that drops a table or column, narrows a column type, rebuilds a SQLite table (`__new_<table>`), renames, truncates, or deletes every row is reported with its `migration.sql:<line>` unless its file carries a `-- guren:allow-destructive: <reason>` comment. A statement against a table an earlier pending migration creates is exempt, so a fresh database still applies the whole history, and a type change the drizzle-kit snapshots show widening passes, as does a SQLite rebuild they show copying every column (an added default or foreign key).

- **`guren db:migrate` now refuses such a migration before applying anything, in every environment.** This is a behaviour change: a deploy script running `db:migrate` over an unacknowledged drop stops with a non-zero exit. Add the comment to the migration, or pass `--allow-destructive` for one run. `--dry-run` judges the pending migrations without applying them (it now reads the database's migration tracker) and exits 1 on a finding; `--json` reports what was judged under `destructive`.
- The SQLite, PostgreSQL, MySQL and Data API factories take `destructiveMigrations: 'warn' | 'refuse'` for the migrations they apply at boot. The default is `'warn'`, which prints the statements and applies them; new apps scaffolded by `create-guren-app` set `'refuse'`. `GUREN_ALLOW_DESTRUCTIVE_MIGRATIONS=1` lets one refused run through. `DestructiveMigrationError` and the `DestructiveMigrationMode` type are exported from `@guren/core`.
- `migrationStatus()` rows carry the `path` of each local `migration.sql`.
- `guren check` (and so `check --ci` and `guren gate`) reports an unacknowledged destructive migration among those not yet on `main`. This is also the guard for Cloudflare D1, whose migrations wrangler applies.
- A newly installed agent harness asks before `db:fresh`, `db:reset`, `db:migrate --allow-destructive` and `queue:flush` (Claude `permissions.ask`, Codex `prompt` rules). `agent:sync` does not rewrite an existing `.claude/settings.json` or `.codex/rules/guren.rules`, so add those entries by hand. The `db-manage` skill, which sync does refresh, tells the agent to ask the user before acknowledging a destructive migration.
