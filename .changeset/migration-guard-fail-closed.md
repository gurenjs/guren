---
"@guren/orm": patch
"@guren/cli": patch
"create-guren-app": patch
---

Close gaps in the destructive-migration guard (RFC 0034), each of which let a destructive statement through:

- The scanner reads SQL in the migration's dialect (from the driver, the factory's `describe()`, or `snapshot.json`; every dialect's reading when none names one): MySQL backslash escapes and `#` comments, PostgreSQL `E'…'` strings. A string can no longer hide the statement after it.
- Statements in a `CREATE PROCEDURE`/`FUNCTION`/`TRIGGER` body, a function body written as a string and an `EXECUTE '…'` literal are judged; SQL built at run time is reported `unreadable`.
- New kinds: `drop-partition` (MySQL `DROP PARTITION`) and `drop-cascade` (`DROP TYPE … CASCADE` and the like, PostgreSQL `DROP OWNED`). `TRUNCATE PARTITION` is a `truncate`.
- A SQLite rebuild is exempt only when the copy's own `CREATE TABLE` keeps every column's type, so a `--custom` migration's repeated snapshot vouches for nothing, and not when another table references it with `ON DELETE CASCADE`/`SET NULL`/`SET DEFAULT` where foreign keys stay on (Cloudflare D1).
- MySQL's bare `DECIMAL` is `DECIMAL(10,0)`, so `DECIMAL(12,2)` to `DECIMAL` is narrowing.
- A refusal over an unreadable migration tracker names the read error and keeps it as the `cause`.
- `guren check` lists changed paths with `git -z`, so a migration folder with a non-ASCII name is judged, and falls back to `origin/HEAD`, then `master`, when there is no `main`; untracked paths are listed root-relative (`--full-name`), so an untracked migration in an app below the repository root is no longer dropped. In an app with migrations, commits with no merge base (a shallow clone) are now a gating `migrations-destructive-no-base` finding, so a CI checkout needs the base branch's history: the scaffolded workflow now checks out with `fetch-depth: 0`, and an existing app running `guren gate` in CI should do the same. On `main` itself the rule says that merged migrations are not judged (`migrations-destructive-on-base`, advisory). It reads `config/database.ts` to tell a bun:sqlite app, whose rebuilds run with foreign keys off, from a D1 one.
