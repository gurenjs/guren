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
bun run db:migrate
```
- First check database is running
- Show pending migrations

### Undoing migrations
Guren migrations are drizzle-kit generated and forward-only — `db:rollback` is
not supported and will explain the alternatives:
- Development: `bunx guren db:reset --seed` (drop everything, re-apply, re-seed)
- Undo an uncommitted migration: delete its folder + journal entry, then `db:reset`
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

Full reset: stop container, start fresh, migrate, and seed.

```bash
bun run db:down && bun run db:up && sleep 3 && bun run db:migrate && bun run db:seed
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
```bash
bun run db:up    # Start PostgreSQL
bun run db:down  # Stop
bun run db:logs  # View logs
```

## Safety Rules

1. **Destructive operations** (rollback, fresh, reset):
   - Always confirm with user
   - Show what will be affected
   - Warn about data loss

2. **Error handling:**
   - DB not running → suggest `bun run db:up`
   - Migration failed → show error, suggest rollback

3. **Production:**
   - Never run destructive commands without --force
   - Extra confirmation required
