# __APP_TITLE__

A fullstack TypeScript application built with [Guren](https://guren.dev).

## Quick Start

```bash
bun install
<!-- guren:container -->
bun run db:up        # start the __DATABASE_LABEL__ container
<!-- /guren:container -->
bun run db:make      # generate a migration from db/schema.ts
bun run db:migrate   # apply it
bun run dev
```

<!-- guren:container -->
__DATABASE_LABEL__ runs in the container `docker-compose.yml` defines, and `DATABASE_URL` in `.env` points at it. `bun run db:down` stops it.
<!-- /guren:container -->
<!-- guren:no-container -->
No Docker and no database server: SQLite keeps the database in the file `DATABASE_URL` names in `.env`.
<!-- /guren:no-container -->

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

- `routes/web.ts` — route definitions, a registrar `src/app.ts` passes to `createApp({ routes })`
- `app/Http/Controllers/` — request handlers
- `app/Models/` — ORM models
- `resources/js/pages/` — React pages (rendered via Inertia.js)
- `config/database.ts` — database configuration
- `db/schema.ts` — Drizzle table definitions

## Database

This app uses __DATABASE_LABEL__. `config/database.ts` creates the connection, and `DATABASE_URL` in `.env` selects the database.

To switch to another driver:

- install its client: `bun add postgres` for PostgreSQL, `bun add mysql2` for MySQL (SQLite needs none);
- change the factory in `config/database.ts` (`createSqliteDatabase`, `createPostgresDatabase` or `createMySqlDatabase`), the `dialect` in `drizzle.config.ts`, and the table builders in `db/schema.ts`;
- empty `db/migrations/` and regenerate it with `bun run db:make`, since a migration is written in one dialect's SQL;
- for PostgreSQL or MySQL, run a server and point `DATABASE_URL` at it. `docker-compose.yml` is written only when the app is created with one of them.

See the [database guide](https://guren.dev/docs/guides/database) for details.

<!-- guren:ssr -->
## Server-Side Rendering

Pages render on the server through Inertia SSR. During development the Bun server reads `resources/js/ssr.tsx` directly. Production builds use the SSR bundle and manifest Vite generates, which `src/main.ts` wires up through `autoConfigureInertiaAssets`.

`bun run build` runs `vite build` for the client and `vite build --ssr` for the server bundle, so the first request is answered with pre-rendered HTML. `bun run preview` then starts the same Bun server in production mode against those manifests.

### Deploy to Vercel

Vercel support is an opt-in plugin for SSR apps:

```bash
bunx guren plugin @guren/plugin-vercel
bun add @guren/plugin-vercel
bun run vercel:build
```

Then deploy with Vercel's prebuilt flow:

```bash
vercel build
vercel deploy --prebuilt
```

<!-- /guren:ssr -->
## Favicon

`public/favicon.svg` ships as a placeholder and is linked from `src/app.ts` via
`createApp({ inertia: { document: { head } } })`, which is the only path that
reaches the production document — `public/index.html` is not read by the
server. Replace the file to change the icon, or edit the `head` markup to add
more tags.

Files at the root of `public/` are served by the Bun runtime. On Node-based
deployments (AWS Lambda, for example) serve them from a CDN instead.

## Scripts

| Command | Description |
|---------|-------------|
| `bun run dev` | Start dev server (Bun + Vite) |
| `bun run build` | Build for production |
| `bun run preview` | Start the built app with the Bun production server |
| `bun run start` | Start the app in production mode (`NODE_ENV=production`); what a deployment runs |
<!-- guren:container -->
| `bun run db:up` | Start the __DATABASE_LABEL__ container |
| `bun run db:down` | Stop the __DATABASE_LABEL__ container |
<!-- /guren:container -->
| `bun run db:make` | Generate a migration from `db/schema.ts` |
| `bun run db:migrate` | Run database migrations |
| `bun run db:seed` | Seed the database |
| `bun run codegen` | Regenerate route/page types |

Run `bun run build` before `bun run preview` so the production server can read the generated manifests from `public/assets`.
