# Guren Blog Example

This example demonstrates how to build a simple blog using the Guren framework, Postgres, and Drizzle ORM.

## Prerequisites

- [Docker](https://www.docker.com/) with Compose v2 support
- Bun (the workspace already targets Bun 1.1+)

## Getting Started

1. **Install dependencies**
   ```bash
   bun install
   ```

2. **Start Postgres**
   ```bash
   bun run db:up
   ```
   The database listens on `localhost:54322` with credentials `guren / guren` and database `guren`.

3. **Configure environment**
   ```bash
   cp examples/blog/.env.example examples/blog/.env
   ```

4. **Run the example**
   ```bash
   bun run --cwd examples/blog dev
   ```
   The API server listens on http://localhost:3333 by default (override with `PORT`) and automatically launches the Vite dev server for the React frontend (typically http://localhost:5173). Set `GUREN_DEV_VITE=0` if you prefer to manage Vite yourself.

5. **Smoke test**
   ```bash
   bun run --cwd examples/blog smoke
   ```
   This waits for the application bootstrap, asserts that the home page returns SSR-rendered markup, and verifies the `/posts` JSON endpoint. If the database isn't reachable, the script exits gracefully.

## Shutting Down

```bash
bun run db:down
```

Logs are available through `bun run db:logs`.

## Building for Production

```bash
NODE_ENV=production bun run --cwd examples/blog build
```
The `build` script runs both `bunx vite build` and `bunx vite build --ssr`, generating the client manifest at `public/assets/.vite/manifest.json` and the SSR manifest at `public/assets/.vite/ssr-manifest.json`. At runtime `src/main.ts` calls `autoConfigureInertiaAssets`, which reads those files and automatically sets the `GUREN_INERTIA_*` environment variables so server-side rendering is enabled without extra configuration.

## Database Tasks

- `bun run --cwd examples/blog db:make` – generate a new SQL migration via drizzle-kit.
- `bun run --cwd examples/blog db:migrate` – apply pending migrations.
- `bun run --cwd examples/blog db:seed` – execute all configured seeders.
