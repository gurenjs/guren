# __APP_NAME__

API-only application built with [Guren](https://guren.dev).

## Getting Started

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

## API Endpoints

- `GET /health` — Health check
- `GET /api/v1/` — API root

## Development

```bash
bun run dev        # Start dev server
bun run typecheck  # Type check
bun run test       # Run tests
```

In production, start the server with `bun run start`, which sets `NODE_ENV=production`. HSTS, the `Secure` session cookie and hidden error details depend on it.
