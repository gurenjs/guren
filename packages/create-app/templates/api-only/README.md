# __APP_NAME__

API-only application built with [Guren](https://github.com/user/guren).

## Getting Started

```bash
bun install
bun run db:migrate
bun run dev
```

If you scaffolded with PostgreSQL or MySQL, this project also has a `docker-compose.yml` and `bun run db:up` / `bun run db:down` to start and stop the database container. Start it before `bun run db:migrate`.

## API Endpoints

- `GET /health` — Health check
- `GET /api/v1/` — API root

## Development

```bash
bun run dev        # Start dev server
bun run typecheck  # Type check
bun run test       # Run tests
```
