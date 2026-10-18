---
name: db-manage
description: Database management for Guren with safety checks. Handles migrations, rollbacks, seeding, resets, and container management. Use when user mentions "database", "migration", "migrate", "rollback", "seed", "reset", "db:up", "db:down", "db:reset", "fresh database", or database-related tasks.
---

# Database Management Skill

You are a database management assistant for the Guren framework.

## Your Role

Help manage database operations safely with proper confirmations.

## Commands

### Status
```bash
bunx guren db:status
```

### Migrate
```bash
bunx guren db:migrate --dry-run   # judge the pending migrations, apply nothing
bun run db:migrate
```
- First check database is running
- Show pending migrations

### Destructive migrations

`db:migrate` reads every pending `migration.sql` first and refuses, in every
environment, a statement that drops a table or column, narrows a column type,
rebuilds a SQLite table (`__new_<table>`), renames, truncates, or deletes every
row, unless the file carries an acknowledgement. Apps scaffolded with
`destructiveMigrations: 'refuse'` in `config/database.ts` refuse the same
migration at boot (`bun run dev`, `bun test`, a deploy). `guren check` and the
Stop hook report one added on the current branch. Each finding names
`db/migrations/<folder>/migration.sql:<line>`.

When the guard refuses:

1. Read the statement. A drop that drizzle-kit wrote because a column was
   renamed in `db/schema.ts` is usually a mistake: drizzle-kit asks whether a
   removed-and-added column is a rename only in an interactive terminal. Delete
   the generated folder and ask the user to run `bun run db:make` themselves,
   answering the rename prompt. The rename it writes is refused too (a deploy
   still running reads the old name), but it loses no rows, and step 2 is a
   shorter conversation.
2. If the data loss is intended, **ask the user before acknowledging it.** Say
   which table or column loses what.
3. With the user's yes, put the acknowledgement on the **first line** of that
   `migration.sql` (a comment after the last `--> statement-breakpoint` is an
   empty statement and fails on SQLite):

   ```sql
   -- guren:allow-destructive: <why this data can go, for the reviewer>
   ```

   The reason is what the reviewer reads. `--allow-destructive` applies once
   without editing the file; it also needs the user's yes.

Never add the marker or the flag to get past a refusal on your own: it records
that a person decided the data can go.

### Undoing migrations
Guren migrations are drizzle-kit generated and forward-only — `db:rollback` is
not supported and will explain the alternatives:
- Development: `bunx guren db:reset --seed` (drop everything, re-apply, re-seed)
- Undo an uncommitted migration: delete its folder under `db/migrations/` (there is no journal to edit), then `db:reset`
- Production: write a new forward migration that reverses the change

### Status
```bash
bunx guren db:status
```
- Shows applied/pending state for every generated migration

### Fresh (destructive)
```bash
bunx guren db:fresh
bunx guren db:fresh --seed
```
- DROPS ALL TABLES
- Require explicit confirmation
- Block in production

### Seed
```bash
bun run db:seed
```

### Reset

Full reset. On a container-backed project, stop the container, start it fresh,
then migrate and seed:

```bash
bun run db:down && bun run db:up && sleep 3 && bun run db:migrate && bun run db:seed
```

On SQLite there is no container — `db:reset` drops every table in place:

```bash
bun run db:reset && bun run db:migrate && bun run db:seed
```

- This destroys all existing data in the development database
- The `sleep 3` ensures PostgreSQL is ready before migrations
- ALWAYS confirm with user before running
- If reset fails:
  1. Check if Docker is running
  2. Check if port 54322 is available
  3. Review migration errors if migrations fail

### Create Migration
```bash
bunx guren make:migration <name>
```
Then provide schema template.

### Container Management

Only projects scaffolded with PostgreSQL or MySQL have a `docker-compose.yml`
and these scripts. SQLite projects have neither — the database is a file.

```bash
bun run db:up    # Start the database container
bun run db:down  # Stop it
docker compose logs -f   # Follow its logs
```

## Safety Rules

1. **Destructive operations** (rollback, fresh, reset, a destructive migration):
   - Always confirm with user
   - Show what will be affected
   - Warn about data loss

2. **Error handling:**
   - DB not running → suggest `bun run db:up` (container-backed projects only)
   - Migration failed → show error, suggest rollback

3. **Production:**
   - Never run destructive commands without --force
   - Extra confirmation required
