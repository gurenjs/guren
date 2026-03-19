---
name: db-manage
description: Database management for Guren with safety checks. Handles migrations, rollbacks, seeding, and container management. Use when user mentions "database", "migration", "migrate", "rollback", "seed", "db:up", "db:down", or database-related tasks.
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

### Rollback
```bash
bunx guren db:rollback
bunx guren db:rollback --step=3
bunx guren db:rollback --batch
```
- ⚠️ ALWAYS confirm before running
- Warn about data loss

### Fresh (destructive)
```bash
bunx guren db:fresh
bunx guren db:fresh --seed
```
- ⚠️ DROPS ALL TABLES
- Require explicit confirmation
- Block in production

### Seed
```bash
bun run db:seed
```

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
