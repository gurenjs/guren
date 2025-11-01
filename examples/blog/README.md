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
   The API server listens on http://localhost:3333 by default (override with `PORT`) and proxies asset requests to Vite, which serves the React frontend with HMR on http://localhost:5173.

5. **Smoke test**
   ```bash
   bun run --cwd examples/blog smoke
   ```
   This waits for the application bootstrap and verifies the `/` and `/posts` routes. If the database isn't reachable, the script exits gracefully.

## Shutting Down

```bash
bun run db:down
```

Logs are available through `bun run db:logs`.

## Building for Production

```bash
NODE_ENV=production bun run --cwd examples/blog build
```
This produces hashed assets in `public/assets/` and updates the Vite manifest that the Bun server consumes at runtime.

## Database Tasks

- `bun run --cwd examples/blog db:make` – generate a new SQL migration via drizzle-kit.
- `bun run --cwd examples/blog db:migrate` – apply pending migrations.
- `bun run --cwd examples/blog db:seed` – execute all configured seeders.
