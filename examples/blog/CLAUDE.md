# Blog Example App

## Structure
- `src/main.ts` — application bootstrap
- `routes/web.ts` — HTTP route definitions
- `app/Http/Controllers/` — controllers
- `app/Models/` — Drizzle-backed models
- `db/schema.ts` — database schema
- `db/migrations/` — migration files
- `resources/js/pages/` — Inertia React pages
- `tests/` — Vitest specs (`*.test.ts` for server, `*.test.tsx` for React)

## Commands
```bash
bun run dev       # Boot API server + Vite HMR
bun run smoke     # Verify critical routes after boot
bun run build     # Production assets via Vite
bun run codegen   # Regenerate route/page types
bun run db:make   # Generate migration
bun run db:migrate # Apply migrations
bun run db:seed   # Seed fixtures
```

## Conventions
- Two-space indentation, single quotes, no semicolons (match existing files)
- Controllers use `PascalCaseController` naming; routes reference via `[Controller, 'method']` arrays
- Inertia pages follow directory-based naming (`resources/js/pages/posts/Index.tsx` → `posts/Index`)
- Generated route typings in `types/generated/routes.d.ts` are build output managed by CLI

## Testing
- Vitest with `jsdom` and Testing Library for UI assertions
- Shared mocks in `tests/setup.ts`; call `configureInertiaVitest()` from `@guren/testing`
- Run `bun run smoke` before opening PRs
