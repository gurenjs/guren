# @guren/orm

## Purpose
Houses the ORM-facing surface (Model base class, Drizzle adapter, Postgres helpers, seeder utilities). Default adapter is Drizzle; consumers can swap adapters by calling `Model.useAdapter()`.

## Key Exports
- `Model`, `PlainObject`, `WhereClause`, and `ORMAdapter` interfaces
- `DrizzleAdapter` plus helper factories (`createPostgresDatabase`, `runSeeders`, `defineSeeder`, `loadSeeders`)

## Conventions
- PascalCase for files that export classes (`Model.ts`); helper modules stay kebab-case (`postgres.ts`, `seeder.ts`)
- Keep adapters self-contained; avoid importing from `@guren/server` to prevent cycles
- Treat `drizzle-orm` and `postgres` as peer deps — type-safe but optional
- Every driver constructs its own client and passes `drizzle({ client })`; never `connection:`. Drizzle builds the client itself for `connection:`, and for mysql2 it picks the promise-API pool, which has no `.config` for the driver to write to — so every query throws before reaching a socket. Mocked unit tests cannot catch that; each driver needs live-server coverage (see `tests/mysql-integration.test.ts`)

## Build & Tests
- Build with `bun run --cwd packages/orm build`
- When adding adapters, update `tsconfig.json` paths and ensure new peer deps are declared
