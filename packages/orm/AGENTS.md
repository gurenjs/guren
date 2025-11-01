# @guren/orm — AI Coding Notes

## Purpose
- Houses the ORM-facing surface (Model base class, Drizzle adapter, Postgres helpers, seeder utilities).
- Default adapter is Drizzle; consumers can swap adapters by calling `Model.useAdapter()`.

## Key Exports
- `Model`, `PlainObject`, `WhereClause`, and `ORMAdapter` interfaces.
- `DrizzleAdapter` plus helper factories (`createPostgresDatabase`, `runSeeders`, `defineSeeder`, `loadSeeders`).

## Conventions
- Stick to PascalCase for files that export classes (`Model.ts`); helper modules stay kebab-case (`postgres.ts`, `seeder.ts`).
- Keep adapters self-contained; avoid importing from `@guren/server` to prevent cycles.
- Treat `drizzle-orm` and `postgres` as peer deps—type-safe but optional.

## Build & Tests
- Build with `bun run --cwd packages/orm build`.
- When adding adapters, update `tsconfig.json` paths and ensure new peer deps are declared.
