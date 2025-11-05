# Repository Guidelines

## Project Structure & Module Organization
- `src/main.ts` boots the Bun + Hono application and mounts routes.
- `routes/web.ts` registers HTTP routes; controllers live in `app/Http/Controllers/`.
- Domain models sit in `app/Models/`, backed by Drizzle schema in `db/schema.ts` and migrations under `db/migrations/`.
- Frontend Inertia pages reside in `resources/js/pages/`; shared UI pieces stay near their usage.
- `tests/` hosts Vitest specs (`*.test.ts` for server logic, `*.test.tsx` for React pages) with common setup in `tests/setup.ts`.
- Generated route typings live in `types/generated/routes.d.ts`; treat it as build output managed by the CLI.

## Build, Test, and Development Commands
- `bun install` installs workspace dependencies.
- `bun run dev` boots the Bun API server (`bin/serve.ts`) and automatically launches the Vite dev server for HMR.
- `bun run smoke` executes `smoke.ts` to verify critical routes after boot.
- `bun run build` builds production assets via Vite; follow with `bun run preview` for a static preview.
- `bun run routes:types` regenerates `types/generated/routes.d.ts`; rerun after editing `routes/web.ts` or adding route params.
- Database helpers: `bun run db:make` (generate migration), `bun run db:migrate` (apply), `bun run db:seed` (seed fixtures).

## Coding Style & Naming Conventions
- TypeScript and React files should remain Prettier-style: two-space indentation, single quotes, and no semicolons (match existing files such as `app/Http/Controllers/PostController.ts`).
- Controllers use `PascalCaseController` naming; routes reference them via `[Controller, 'method']` arrays.
- Inertia pages follow directory-based naming (`resources/js/pages/posts/Index.tsx` maps to `posts/Index`); keep shared UI near its feature.
- Prefer `async/await`, typed payloads, and return helpers like `this.inertia()` or `this.json()` for clarity.

## Testing Guidelines
- Use Vitest with `jsdom` and Testing Library for UI assertions. Register shared mocks in `tests/setup.ts`.
- Name new specs `FeatureName.test.ts[x]` in the relevant subfolder. Group assertions by controller or page feature to keep suites focused.
- Run `bun run test -- --watch` during development; ensure `bun run smoke` passes before opening a PR.
- Call `configureInertiaVitest()` from `@guren/testing` in `tests/setup.ts` so controller/page specs align with framework mocks.

## Commit & Pull Request Guidelines
- The repo history is empty; adopt Conventional Commits (e.g., `feat: add posts feed controller`) to stay consistent with the broader Guren projects.
- Each PR should describe the motivation, summarize changes by area (routes, controllers, UI, tests), and list verification steps run locally.
- Link related issues when available and include visuals or payload samples for UI or API changes.

## Environment & Database Tips
- Copy `.env.example` to `.env` and keep secrets in user-specific overrides rather than committing them.
- Postgres runs via `bun run db:up` on `localhost:54322` with `guren/guren`; use dedicated schemas when testing destructive changes.
