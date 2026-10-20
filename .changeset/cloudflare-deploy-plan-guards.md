---
"@guren/plugin-cloudflare": minor
"@guren/core": minor
"@guren/cli": minor
---

`guren cloudflare:deploy --plan` now checks migrations and secrets (RFC 0035 §5, §6).

- **Migrations.** The plan reads the D1 database's `d1_migrations` tracker through `cf d1 query`. A database not created yet has applied nothing. The plan picks the layout from the names the tracker records: flattened `<folder>.sql` (Wrangler, or cf over `.guren/cloudflare/d1-migrations`) or nested `<folder>/migration.sql`. A tracker holding both forms is a `tracker-layout` blocker. The plan judges the pending migrations with RFC 0034's destructive-migration guard. An unacknowledged statement is a `destructive-migration` blocker unless `--allow-destructive` (or `GUREN_ALLOW_DESTRUCTIVE_MIGRATIONS=1`) turns it into a warning. The plan prints the `cf d1 migrations apply` arguments for the layout. A tracker it cannot read is `source-unreadable`, never "nothing applied".
- **Secrets.** The required variables come from `config/env.ts`, parsed as production would parse it. The plan compares them with the deployed Worker's secrets, the config's text bindings, and the names in `--secrets-file` (whose values are never read). Anything missing is a `secrets` blocker that names the command to fix it.
- `@guren/core/internal/deploy-plan` gives deploy plugins `judgePendingMigrations()`, `readRequiredDeployEnv()` and `readEnvFileKeys()`. `@guren/cli` exports `requiredDeployEnv()`, `envFileKeys()` and `assignedEnvKeys()` (the keys a dotenv file assigns a non-blank value to) for it.
