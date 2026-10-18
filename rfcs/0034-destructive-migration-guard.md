# RFC: Destructive Migration Guard

**Author:** Urata Daiki (@7nohe)
**Date:** 2026-10-18
**Status:** Draft

> A migration that drops a table, drops a column or narrows a type should not
> reach a database because an agent ran `bun run dev`. This RFC reads every
> migration before it is applied and refuses the destructive statements nobody
> acknowledged with a `-- guren:allow-destructive` comment in the file.

## Problem

Guren applies drizzle-kit migrations in two places, and neither reads what it
applies.

- **At boot.** Every driver's `configureOrm()` awaits its migration
  single-flight, so `guren dev`, `bun test`, `TestApp` and a production start
  all apply whatever is pending before the first request
  (`packages/orm/src/{sqlite,postgres,mysql,aws-data-api}.ts`, all through
  `migrateAndReport()` in `migration-utils.ts`).
- **`guren db:migrate`**, which calls the same `migrateDatabase()`.

A coding agent that edits `db/schema.ts` and runs `bun run db:make` gets
whatever drizzle-kit decided. When the agent removes a column and adds another
in one edit, drizzle-kit asks whether that is a rename; run without a terminal
it cannot ask, and the agent's next `bun run dev` drops the column with its
data. drizzle-kit prints a `⚠ drop_column` line when it generates such a
migration, and nothing after that point looks again.

The existing guard does not cover this. `assertDestructiveCommandAllowed()`
(`packages/cli/src/commands/destructive-guard.ts`) refuses `db:seed`,
`db:reset`, `db:fresh`, `queue:retry` and `queue:flush` under
`NODE_ENV=production` without `--force`. It is about the command, not the SQL,
and `db:migrate` is deliberately outside it.

The harness makes this worse rather than better. The Codex rules template
(`packages/cli/templates/agent/targets/codex/rules/guren.rules`) allows the
prefix `bunx guren` without approval, and the Claude template allows
`Bash(bunx guren:*)`, so `bunx guren db:fresh` runs unprompted in both.

Void requires `-- void:allow-destructive` in a migration before it applies a
destructive statement. Guren's case for itself is that an agent can work in it
safely; at present a destructive migration is the one database change that
needs no evidence of intent.

## Proposed Solution

### 1. What counts as destructive

A pure scanner, `scanMigrationSql(sql)` in `packages/orm/src/migration-guard.ts`,
splits a migration into statements and reports each destructive one with its
line. It tokenizes rather than matching the raw text: `--` and `/* */`
comments, `'…'` strings, `"…"` and `` `…` `` identifiers and PostgreSQL
`$tag$…$tag$` bodies are skipped, statements end at a top-level `;`, and
`--> statement-breakpoint` is an ordinary comment. A dollar-quoted body is
scanned again as SQL, so a `DO $$ … DROP TABLE … $$` block is not hidden by its
quoting, and a statement is read from its first `DROP`, `ALTER`, `RENAME`,
`TRUNCATE`, `DELETE` or `CREATE`, so a `BEGIN` or `IF … THEN` in front hides
nothing either. An unterminated string, comment or body is itself a finding
(`unreadable`): the scanner cannot say what follows it, so it does not pass it.

| Kind | Statement (PostgreSQL, MySQL, SQLite as drizzle-kit 1.0.0-rc.4 writes them) |
|---|---|
| `drop-table` | `DROP TABLE "posts";` |
| `drop-column` | `ALTER TABLE "users" DROP COLUMN "bio";` |
| `alter-column-type` | `ALTER TABLE "users" ALTER COLUMN "age" SET DATA TYPE smallint USING …;` (PG), `ALTER TABLE \`users\` MODIFY COLUMN \`age\` smallint;`, `CHANGE COLUMN` (MySQL) |
| `table-rebuild` | SQLite's `CREATE TABLE \`__new_users\` … INSERT … SELECT … DROP TABLE \`users\`; ALTER TABLE \`__new_users\` RENAME TO \`users\`;`, reported once, at the `DROP TABLE` line |
| `rename` | `ALTER TABLE … RENAME TO …`, `RENAME COLUMN`, MySQL `RENAME TABLE` |
| `truncate` | `TRUNCATE …` |
| `delete-all` | `DELETE FROM …` with no `WHERE` |
| `drop-schema` | `DROP SCHEMA`, `DROP DATABASE` |
| `unreadable` | see above |

A rename loses no rows, but every running instance of the previous deploy
reads the old name until it is replaced, which is the same outage a drop
causes. drizzle-kit never writes `TRUNCATE` or `DELETE`, and writes a rename
only after its interactive prompt; those kinds exist for hand-written
migrations (`drizzle-kit generate --custom`).

**Widening is not destructive, but only when the snapshots prove it.**
PostgreSQL's `SET DATA TYPE` and MySQL's `MODIFY COLUMN` look the same for
`varchar(255)` → `varchar(50)` and `varchar(50)` → `varchar(500)`, so the SQL
alone cannot tell them apart. drizzle-kit 1.x writes a `snapshot.json` beside
every `migration.sql`, with `prevIds` naming the snapshot before it and each
column's `type`. A type change is exempt when the previous snapshot's type and
this migration's snapshot type are both readable and the change is on a closed
widening list (a longer `varchar`, `varchar`/`char` to `text`, up the integer
ladder, a `numeric` keeping its integer digits and scale, up MySQL's text
ladder). Anything else, including a snapshot that is missing, unreadable or
names no such column, is reported. A custom migration's snapshot repeats its
predecessor's, so a type change in hand-written SQL is always reported.

**A rebuild that copies every column loses nothing either.** drizzle-kit
rebuilds a SQLite table for changes as small as an added default or foreign
key. A rebuild is exempt when its `INSERT INTO __new_x(…) SELECT … FROM x`
copies each column to itself, every column the previous snapshot gives the
table is among them, and each keeps or widens its type in this migration's
snapshot. Without the snapshots, or with a column left behind, it is reported.

**A statement against a table the same run creates loses nothing.** A fresh
database (a new clone, a CI test database, `bun test` on a new SQLite file)
applies every migration from the first, including a `DROP TABLE` that a later
migration wrote two years ago. A finding whose table a `CREATE TABLE` earlier
in the pending set creates is exempt. `CREATE TABLE IF NOT EXISTS` counts,
because drizzle-kit 0.x wrote every create that way. It can no-op over an
existing table only when the tracker never recorded creating it (a table made
by `drizzle-kit push` or by hand), which the guard accepts as out of reach. This is what keeps the guard from
refusing every fresh setup of an app with history, and it also exempts a
branch that adds a table and then changes its mind.

### 2. Acknowledgment

A migration is acknowledged when it carries the marker in a `--` comment:

```sql
-- guren:allow-destructive: posts moved to articles in 20261012_copy_posts; nothing reads it since v4.2
DROP TABLE "posts";
```

The text after the colon is the reason. It is optional, and its absence is
printed as a note beside the acknowledged migration, never as a refusal. The
marker covers the whole file. It belongs on the first line: drizzle's
migrator splits on `--> statement-breakpoint`, and a comment-only chunk after
the last breakpoint is a statement some drivers reject as empty.

The marker is evidence of intent that a reviewer sees in the diff, not access
control. An agent can type it as easily as the statement. The harness skill
(§6) tells the agent to ask the user before adding it, and code review is
where a reason that does not hold up is caught.

### 3. Where it is enforced

**Boot (`@guren/orm`).** `migrateAndReport()` already reads the tracker to name
pending migrations. Before it calls the migrator it reads each pending
`migration.sql` (and the snapshots when a type change needs them) and judges
them. A new factory option chooses what happens to unacknowledged findings:

```ts
createSqliteDatabase({
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  destructiveMigrations: 'refuse', // 'warn' | 'refuse'
})
```

- `'refuse'` throws before anything is applied, naming each finding as
  `db/migrations/<folder>/migration.sql:<line>` and both ways forward (the
  marker, or `GUREN_ALLOW_DESTRUCTIVE_MIGRATIONS=1` for one run).
- `'warn'` prints the same findings with `console.warn` and applies.

The default is `'warn'` in v2 and becomes `'refuse'` in the next major (see
Migration Path). The create-app database templates pass `'refuse'`, so every
new app is guarded from its first boot, in every environment. `'refuse'` with
the variable set applies and still prints the findings.

Pending names come from the tracker. When the tracker cannot be read,
`readMigrationDrift()` returns no pending names and boots on; the guard does
not inherit that. It judges every local migration instead, with the
created-in-run exemption off: over a set that includes applied migrations, an
applied `CREATE TABLE posts` would otherwise exempt a new `DROP TABLE posts`.
That can refuse a historical drop, which is the price of not knowing what is
pending. `db:migrate` does the same for a config with no `migrationStatus()`. After
`resetDatabase()` the drivers skip the tracker read (`reapplyingAfterReset`),
and the guard skips with it: every table was just dropped, so nothing applied
in that run can lose data. `db:reset` and `db:fresh` keep their production
`--force` guard and are otherwise outside this RFC.

**`guren db:migrate`.** The command asks `migrationStatus()` for the pending
migrations, judges them before calling `migrateDatabase()`, and refuses with a
non-zero exit whatever the factory option says and whatever `NODE_ENV` is.
Flags:

- `--allow-destructive` applies anyway (it sets the variable above for this
  process, so the boot-path guard inside `migrateDatabase()` agrees).
- `--dry-run` judges and reports without applying, and exits non-zero on an
  unacknowledged finding, so an agent can use it as a check. It now opens the
  database to read the tracker.
- `--json` adds `destructive: { pending, findings, acknowledged }` to the
  existing output.

The migration file is located through a new optional `path` on each
`migrationStatus()` row, the absolute `migration.sql` the driver read. An app
on an older `@guren/orm` has no `path`, and the CLI falls back to the drizzle
config's `out` (default `db/migrations`). A pending name whose file is not
there is a refusal, never a skip. A config that exports no
`migrationStatus()` has every local migration judged.

**`guren check` and `guren gate`.** A new rule, `migrations-destructive`, judges
the `*/migration.sql` files that are not on the base branch yet: the merge-base
diff, uncommitted changes and untracked files, as `getChangedFiles()` lists
them, whether or not `--changed` was passed. A historical drop that already
shipped is never reported. An unacknowledged finding is a gating `warn`, so
`check --ci` and the gate's check stage fail on it, and the Stop hook sends
the agent back before it ends a turn with one in the tree. Outside a git
repository, or with no merge base, the rule reports itself as unverified
(advisory) rather than passing. The rule reads files only: it never imports
`drizzle.config.ts` or `config/database.ts`, which run app code.

**Cloudflare D1.** D1 migrations are applied by `wrangler d1 migrations apply`,
which Guren never runs, and `migrationStatus()` throws there because wrangler's
tracker is authoritative. The `check` rule is the D1 guard: it reads the same
`db/migrations/<folder>/migration.sql` files `cloudflare:build` flattens for
wrangler. The D1 docs say to run `bunx guren check` before `wrangler d1
migrations apply`.

### 4. The scanner's home

`migration-guard.ts` lives in `@guren/orm`, because the boot path is there and
`@guren/orm` must not import the CLI. It is published as
`@guren/orm/internal/migration-guard` for `@guren/cli`, which already depends
on `@guren/orm`. It reads no files itself; a small loader beside it turns a
folder and a list of names into the scanner's input.

### 5. The existing production guard

`assertDestructiveCommandAllowed()` stays as it is. It answers a different
question, "should this command run in production at all", and covers commands
whose damage is not in a migration file (seeders, `db:reset`, queue flushes).
The two meet only in names: `--force` there, `--allow-destructive` and the
marker here. The `db:migrate` guard is not production-only, because the data an
agent destroys in development is someone's afternoon, and because a guard
that is off in the environment where the agent works is one it never meets.

### 6. Harness

- **Claude** (`templates/agent/targets/claude/settings.json`): a
  `permissions.ask` list, which takes precedence over `allow`, for
  `bunx guren db:fresh`, `bunx guren db:reset`, `bunx guren db:migrate
  --allow-destructive` and `bunx guren queue:flush`.
- **Codex** (`targets/codex/rules/guren.rules`): `prompt` rules for the same
  prefixes. Codex resolves overlapping prefix rules to the most restrictive
  decision, so they hold beside the broad `bunx guren` allow.
- Both are prefix rules, so `bunx guren db:migrate --json --allow-destructive`
  is not caught. The refusal is still the guard; the prompt is a second chance
  for the user to see the flag.
- **`db-manage` skill**: what the guard reports, that the agent asks the user
  before adding the marker or the flag, and that the marker's reason is for the
  reviewer.

## Alternatives Considered

**Guard `db:migrate` only.** Simplest, and the first draft of this RFC. Every
boot applies migrations, so `bun run dev` would apply what `db:migrate` refused.

**Refuse at boot by default in v2.** Matches Void, and protects existing apps
without an edit. A production deploy carrying an unacknowledged drop would then
fail to start rather than drop the column. That trade is right, but it is a
behaviour change to a stable major for apps that never opted in, so v2 warns
and v3 refuses.

**Production only, like `assertDestructiveCommandAllowed()`.** The agent works
in development, and that is where it would meet the guard.

**Use drizzle-kit's own warnings.** drizzle-kit prints `⚠ drop_column` while
generating and keeps nothing; the next process has only the SQL.
`drizzle-kit generate --explain` describes a schema diff, not a migration
someone already wrote or edited by hand.

**Reconstruct the old type from the SQL.** `USING "age"::smallint` names the new
type only. The snapshots carry both, so the exemption reads them.

**A per-statement marker.** Void and this RFC mark the file. A file is what a
reviewer reads, and drizzle-kit regenerates statements in an order the author
does not choose.

## Migration Path

Existing apps:

- **`guren db:migrate` refuses a pending unacknowledged destructive migration**
  from the release that ships this, in every environment. A deploy script that
  runs `db:migrate` stops before anything is applied. The fix is the marker
  with a reason, or `--allow-destructive` for one run. This is the one
  behaviour change in v2, released as a minor of `@guren/cli` with the change
  named in the changeset, on the reading that a refusal before any write is a
  safety fix rather than a removed capability (decided, Open Question 1).
- **Boot** warns and applies, as now plus the warning. Setting
  `destructiveMigrations: 'refuse'` opts in.
- `guren check --ci` and `guren gate` fail on an unacknowledged destructive
  migration added on the current branch. Merged migrations are never judged.
- `guren agent:sync` refreshes the `db-manage` skill and the harness entry.
  `.claude/settings.json` and `.codex/rules/guren.rules` are user-owned, and
  sync never rewrites a policy file, so an existing app adds the `ask` entries
  and `prompt` rules by hand; a new `agent:init` writes them.

Next major: the boot default becomes `'refuse'`; `'warn'` stays available.

## Open Questions

1. ~~Is `db:migrate` refusing by default a minor or a major?~~ Decided
   (2026-10-18, maintainer): a minor, with the behaviour change named in the
   changeset, and the boot default staying `'warn'` in v2 and becoming
   `'refuse'` in the next major.
2. Should `'refuse'` also apply to `db:reset`/`db:fresh`? Those empty the
   database first, so nothing in a migration can lose data that the reset did
   not already drop, and the draft says no.
3. Should the `check` rule also read migrations under `modules/*/`? drizzle-kit
   writes one migrations folder per config, and the draft judges every
   `migration.sql` the diff lists, wherever it is.
