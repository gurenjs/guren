## Project Structure

```
app/
├── Http/
│   ├── Controllers/    # Request handlers
│   ├── Middleware/      # HTTP middleware
│   └── Resources/       # API resource transformers
├── Models/              # Drizzle ORM models
├── Events/              # Event classes
├── Listeners/           # Event listeners
├── Jobs/                # Queue job classes
├── Mail/                # Mailable classes
├── Notifications/       # Notification classes
├── Providers/           # Service providers
├── Exceptions/          # Custom exceptions
└── Console/Commands/    # CLI commands
bin/
└── serve.ts             # Server entry point
config/                  # Application configuration
db/
├── schema.ts            # Drizzle table definitions
├── migrations/          # SQL migration files
├── factories/           # Model factories
└── seeders/             # Database seeders
resources/js/
├── pages/               # Inertia.js React pages
├── components/          # Shared React components
└── layouts/             # Page layouts
routes/
├── web.ts               # Web routes
└── api.ts               # API routes (if applicable)
tests/
├── controllers/         # Controller tests
└── models/              # Model tests
```

## Development Commands

```bash
# Start development server
bun run dev

# Generate components
bunx guren make:controller <Name>
bunx guren make:model <Name>
bunx guren make:migration <name>
bunx guren make:view <path>
bunx guren make:middleware <Name>
bunx guren make:job <Name>
bunx guren make:event <Name>
bunx guren make:listener <Name> --event=<EventName>
bunx guren make:mail <Name>
bunx guren make:test <Name>

# Growing past a flat app/? Scaffold a self-contained module:
bunx guren make:module <Name>                    # modules/<name>/{index.ts,routes.ts,db/schema.ts}, wired into src/app.ts
bunx guren make:controller <Name> --module <name> # most make:* commands accept --module

# Database workflow: edit db/schema.ts first, then
bunx guren make:migration <name>   # generate SQL migration via drizzle-kit into db/migrations/
bun run db:migrate                 # apply pending migrations; refuses a drop, narrowing or rename without
                                   # `-- guren:allow-destructive: <reason>` (ask the user first; db-manage skill)
bunx guren db:status               # show applied/pending state
bun run db:seed                    # run seeders
# Migrations are forward-only (no rollback). Dev reset: bunx guren db:reset --seed

# Build & test
bun run build
bun run test
bunx guren gate                    # every CI stage (codegen, typecheck, lint, check, audit, test); exit 0 = done
```

Implementation plans: the `plan-write` and `plan-implement` skills. Browser
verification: the `verify-in-browser` skill. Each lists its own commands.

## MCP Server (AI Agent Integration)

`bun run dev` serves an MCP endpoint at `http://localhost:3333/_guren/mcp`
(loopback only; `GUREN_MCP=1` in the `dev` script). Its tools mirror the CLI
(`guren_get_context`, `guren_check`, `guren_gate`, …); the `dev-workflow` skill
lists them.

## Architecture Overview

`routes/web.ts` registers routes on a `Router`, each pointing at a
`[Controller, 'method']` tuple. A route's Zod `body`/`query`/`params` schemas are
validated before the action (422) and feed `bunx guren codegen`. Controllers read
`this.validated('<route name>')`, query models and render Inertia pages or JSON.
The signatures are in the `guren context` digest; each file kind's rules attach
from `__RULES_DIR__/` when you open it.

## Testing

`bun:test` + `@guren/testing`; requests run in-process through `TestApp`, no
server. Rules: `__RULES_DIR__/testing.md`.

## Key Files

| Path | Purpose |
|------|---------|
| `__RULES_DIR__/` | Verified API rules (each file's `paths` frontmatter states the covered paths) |
| `__SKILLS_DIR__/guren-api/reference/` | The full API reference behind each rule, read on demand |
