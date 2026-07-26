# __APP_TITLE__

A fullstack TypeScript application built with [Guren](https://guren.dev).

## Quick Start

```bash
bun install
bun run dev
```

That's it. No Docker, no database setup — SQLite is ready out of the box.

Visit `http://localhost:3333` to see your app running.

## Adding Features

```bash
bunx guren add auth          # authentication with login/dashboard
bunx guren add resource posts # CRUD scaffolding for a resource
bunx guren add queue          # background job processing
bunx guren add mail           # email sending
bunx guren add events         # event system
bunx guren add cache          # caching layer
bunx guren add notifications  # notification channels
bunx guren add storage        # local/public disks
bunx guren add broadcasting   # realtime channels
bunx guren add schedule       # task scheduling
```

## Project Structure

- `routes/web.ts` — route definitions
- `app/Http/Controllers/` — request handlers
- `app/Models/` — ORM models
- `resources/js/pages/` — React pages (rendered via Inertia.js)
- `config/database.ts` — database configuration
- `db/schema.ts` — Drizzle table definitions

## Scripts

| Command | Description |
|---------|-------------|
| `bun run dev` | Start dev server (Bun + Vite) |
| `bun run build` | Build for production |
| `bun run preview` | Start the built app with the Bun production server |
| `bun run db:migrate` | Run database migrations |
| `bun run db:seed` | Seed the database |
| `bun run codegen` | Regenerate route/page types |

If you scaffolded with PostgreSQL or MySQL, this project also has a `docker-compose.yml` and `bun run db:up` / `bun run db:down` to start and stop the database container. Start it before `bun run db:migrate`.

Run `bun run build` before `bun run preview` so the production server can read the generated manifests from `public/assets`.

## Switching to PostgreSQL

Update `config/database.ts` to use `createPostgresDatabase` and set `DATABASE_URL`:

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/myapp
```

See the [database guide](https://guren.dev/docs/guides/database) for details.
